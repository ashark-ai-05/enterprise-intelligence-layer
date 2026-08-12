import { createHash } from "node:crypto";
import type { StubEvent } from "../connectors/stubs.js";
import type { AccessControlEntry, SourceItem } from "../connectors/types.js";

export interface SyntheticCorpusSize {
  confluencePages: number;
  jiraIssues: number;
  repositories: number;
  filesPerRepository: number;
}

export interface SyntheticCorpusOptions extends SyntheticCorpusSize {
  seed: string;
}

export interface SyntheticLink {
  from: string;
  to: string;
  type: "documents" | "implemented-by" | "tested-by";
}

/**
 * Query families, named rather than numbered.
 *
 * A single binary relevance list cannot adjudicate three different intents. The
 * previous judgment asked one query — `"<subject> incident 47"` — to be
 * simultaneously an exact issue lookup, a subject search, and a graph
 * traversal, then scored all three against one flat list. A scorer that is
 * right about one is necessarily wrong about the others, so the aggregate
 * measured nothing in particular.
 *
 * Each family carries truth derived independently of the capability it tests.
 */
export type QueryFamily =
  /** Canonical identifier or quoted phrase. Truth is the exact object. */
  | "exact_lookup"
  /** Content subject, no identifiers. Truth is independently assigned subject. */
  | "subject_search"
  /** From an anchor, reach its neighbours. Graph truth is legitimate *here*. */
  | "relationship_navigation"
  /** No document answers it. Truth is absence; the metric is abstention. */
  | "unanswerable"
  /** An answer exists but the viewer may not see it. The metric is leakage. */
  | "denied";

export interface SyntheticRelevanceJudgment {
  query: string;
  relevantSourceObjectIds: string[];
  /** Which capability this query evaluates. Never pool families into one score. */
  family?: QueryFamily;
  /** For relationship_navigation: the object the traversal starts from. */
  anchor?: string;
  /**
   * For `denied`: objects that must never appear for this viewer. Distinct from
   * an empty relevant set — an answer does exist here, it is simply not this
   * viewer's to see, so the metric is leakage rather than abstention.
   */
  forbidden?: string[];
}

export interface SyntheticAclCase {
  sourceObjectId: string;
  level: "container" | "resource" | "chunk";
  allowedPrincipal: string;
  deniedPrincipal: string;
}

export interface SyntheticCorpus {
  seed: string;
  events: {
    confluence: StubEvent[];
    jira: StubEvent[];
    git: StubEvent[];
  };
  links: SyntheticLink[];
  relevance: SyntheticRelevanceJudgment[];
  aclCases: SyntheticAclCase[];
  containerAces: Record<string, AccessControlEntry[]>;
}

export const syntheticCorpusPresets = {
  ci: {
    seed: "eil-ci-v1",
    confluencePages: 60,
    jiraIssues: 100,
    repositories: 3,
    filesPerRepository: 50,
  },
  stress: {
    seed: "eil-stress-v1",
    confluencePages: 1_000,
    jiraIssues: 2_000,
    repositories: 10,
    filesPerRepository: 200,
  },
} as const satisfies Record<string, SyntheticCorpusOptions>;

const TOPICS = [
  "payment retries",
  "identity federation",
  "order reconciliation",
  "ledger settlement",
  "rate limiting",
  "incident response",
  "audit retention",
  "service ownership",
] as const;

const SUBSYSTEMS = [
  "checkout",
  "ledger",
  "gateway",
  "onboarding",
  "settlement",
  "fraud-scoring",
  "notifications",
  "reporting",
  "treasury",
  "disputes",
  "kyc",
  "payouts",
] as const;

/**
 * How many documents share a subject. Real estates gain subjects as they grow;
 * this generator previously did not, so a larger corpus meant hundreds of
 * near-identical documents per subject rather than more subjects. Every query
 * then competed against its own topic cohort, and retrieval scores measured
 * that collision instead of the retrieval system.
 */
const DOCUMENTS_PER_SUBJECT = 10;

const vocabularyCache = new Map<string, readonly string[]>();

/**
 * Subjects for a corpus, sized so documents-per-subject stays roughly constant
 * as the corpus grows. Deterministic for a given set of options.
 */
export function subjectVocabulary(
  options: SyntheticCorpusOptions,
): readonly string[] {
  const total =
    options.confluencePages +
    options.jiraIssues +
    options.repositories * options.filesPerRepository;
  const wanted = Math.max(
    TOPICS.length,
    Math.ceil(total / DOCUMENTS_PER_SUBJECT),
  );
  const cacheKey = `${options.seed}:${wanted}`;
  const cached = vocabularyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const subjects: string[] = [];
  const pairs = TOPICS.length * SUBSYSTEMS.length;
  for (let index = 0; index < wanted; index += 1) {
    const topic = TOPICS[index % TOPICS.length] ?? TOPICS[0];
    const subsystem =
      SUBSYSTEMS[Math.floor(index / TOPICS.length) % SUBSYSTEMS.length] ??
      SUBSYSTEMS[0];
    // Once the topic x subsystem pairs are exhausted, split by region so the
    // vocabulary keeps growing without repeating a subject string.
    const generation = Math.floor(index / pairs);
    subjects.push(
      generation === 0
        ? `${topic} in ${subsystem}`
        : `${topic} in ${subsystem} region-${generation}`,
    );
  }
  const frozen = Object.freeze(subjects);
  vocabularyCache.set(cacheKey, frozen);
  return frozen;
}

function assertSize(options: SyntheticCorpusOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (name === "seed") continue;
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}

function seededIndex(seed: string, key: string, length: number): number {
  const digest = createHash("sha256").update(`${seed}\u0000${key}`).digest();
  return digest.readUInt32BE(0) % length;
}

function topic(options: SyntheticCorpusOptions, key: string): string {
  const subjects = subjectVocabulary(options);
  return subjects[seededIndex(options.seed, key, subjects.length)] ?? TOPICS[0];
}

function at(index: number): string {
  return new Date(
    Date.UTC(2026, 0, 1, 0, index % 24, index % 60),
  ).toISOString();
}

function pageIdAt(index: number): string {
  return `CONF-${index + 1}`;
}

function codeIdAt(options: SyntheticCorpusOptions, index: number): string {
  const repositoryIndex = Math.floor(index / options.filesPerRepository);
  const fileIndex = index % options.filesPerRepository;
  return `service-${repositoryIndex}:src/module-${fileIndex}.ts`;
}

const memberCache = new Map<string, ReadonlyMap<string, string[]>>();

/**
 * Every document assigned a given subject.
 *
 * Deliberately derived only from each object's own identity — the same
 * `seededIndex(seed, key)` the generator uses when building the document — and
 * never from `planLinks()`. That independence is the whole point: if subject
 * truth were selected by the same code that creates the graph edges, scoring
 * graph expansion against it would be circular, which is the defect the family
 * split exists to remove.
 */
export function subjectMembers(
  options: SyntheticCorpusOptions,
  subject: string,
): string[] {
  const cacheKey = `${options.seed}:${options.confluencePages}:${options.jiraIssues}:${options.repositories}:${options.filesPerRepository}`;
  let index = memberCache.get(cacheKey);
  if (index === undefined) {
    const built = new Map<string, string[]>();
    const add = (id: string): void => {
      const key = topic(options, id);
      const bucket = built.get(key);
      if (bucket === undefined) built.set(key, [id]);
      else bucket.push(id);
    };
    for (let i = 0; i < options.confluencePages; i += 1) add(pageIdAt(i));
    for (let i = 0; i < options.jiraIssues; i += 1) add(`PAY-${i + 1}`);
    for (let i = 0; i < options.repositories * options.filesPerRepository; i += 1)
      add(codeIdAt(options, i));
    index = built;
    memberCache.set(cacheKey, built);
  }
  return [...(index.get(subject) ?? [])];
}

export interface LinkPlan {
  /** issue key -> the page that documents it */
  readonly pageFor: ReadonlyMap<string, string>;
  /** issue key -> the code that implements it */
  readonly codeFor: ReadonlyMap<string, string>;
  /** page id -> the issues that reference it, for back-references */
  readonly issuesForPage: ReadonlyMap<string, readonly string[]>;
  /** How many issues had no same-topic page or code to link to. */
  readonly topicFallbacks: number;
}

/**
 * Decide which page and which file each issue links to.
 *
 * Previously these were `index % pageCount` and `index % fileCount`: an issue
 * about payment retries was linked to whatever page happened to sit at that
 * offset, so the "relevant" runbook shared no words with the incident and was
 * reachable only by traversing the link graph. Retrieval then had nothing to
 * find, and a miss could not be told apart from a ranking failure.
 *
 * Links are now drawn from documents that share the issue's topic, so relevance
 * is a property of the content. That also makes the corpus adversarial for
 * free: every other same-topic document becomes a genuine near-miss distractor,
 * and picking the right one requires the explicit cross-reference rather than
 * topic matching alone.
 */
export function planLinks(options: SyntheticCorpusOptions): LinkPlan {
  const pagesByTopic = new Map<string, string[]>();
  for (let index = 0; index < options.confluencePages; index += 1) {
    const id = pageIdAt(index);
    const bucket = pagesByTopic.get(topic(options, id));
    if (bucket === undefined) pagesByTopic.set(topic(options, id), [id]);
    else bucket.push(id);
  }

  const codeByTopic = new Map<string, string[]>();
  const codeCount = options.repositories * options.filesPerRepository;
  for (let index = 0; index < codeCount; index += 1) {
    const id = codeIdAt(options, index);
    const bucket = codeByTopic.get(topic(options, id));
    if (bucket === undefined) codeByTopic.set(topic(options, id), [id]);
    else bucket.push(id);
  }

  const pageFor = new Map<string, string>();
  const codeFor = new Map<string, string>();
  const issuesForPage = new Map<string, string[]>();
  let topicFallbacks = 0;

  for (let index = 0; index < options.jiraIssues; index += 1) {
    const issueKey = `PAY-${index + 1}`;
    const subject = topic(options, issueKey);

    // A topic with no document of its own can happen at small sizes. Fall back
    // to the whole set rather than dropping the link, and count it, so a corpus
    // quietly built out of fallbacks is visible instead of silently weaker.
    const pageBucket = pagesByTopic.get(subject);
    const codeBucket = codeByTopic.get(subject);
    if (pageBucket === undefined || codeBucket === undefined) topicFallbacks += 1;

    const pages =
      pageBucket ??
      Array.from({ length: options.confluencePages }, (_, i) => pageIdAt(i));
    const files =
      codeBucket ?? Array.from({ length: codeCount }, (_, i) => codeIdAt(options, i));

    const pageId = pages[seededIndex(options.seed, `${issueKey}:page`, pages.length)];
    const codeId = files[seededIndex(options.seed, `${issueKey}:code`, files.length)];
    if (pageId === undefined || codeId === undefined) continue;

    pageFor.set(issueKey, pageId);
    codeFor.set(issueKey, codeId);
    const referencing = issuesForPage.get(pageId);
    if (referencing === undefined) issuesForPage.set(pageId, [issueKey]);
    else referencing.push(issueKey);
  }

  return { pageFor, codeFor, issuesForPage, topicFallbacks };
}

function page(
  options: SyntheticCorpusOptions,
  index: number,
  referencingIssues: readonly string[] = [],
): SourceItem {
  const pageId = pageIdAt(index);
  const subject = topic(options, pageId);
  const restricted = index % 20 === 0;
  return {
    sourceObjectId: pageId,
    sourceVersion: "1",
    canonicalUri: `https://mock.atlassian.test/wiki/spaces/ENG/pages/${index + 1}`,
    title: `${subject} design ${pageId}`,
    body: `Architecture guidance for ${subject}.`,
    metadata: {
      pageId: String(index + 1),
      spaceKey: index % 5 === 0 ? "SEC" : "ENG",
      owner: `team-${index % 12}`,
      labels: ["synthetic", subject.replaceAll(" ", "-")],
      sections: [
        {
          anchor: "overview",
          headingPath: ["Overview"],
          text: `The ${subject} service uses bounded retries and observable failure modes.`,
        },
        {
          anchor: "operations",
          headingPath: ["Operations", "Recovery"],
          // Back-reference the issues that actually link here. Previously this
          // named `index % jiraIssues`, which was not the inverse of the
          // forward link, so the two references disagreed about which incident
          // this runbook covered.
          text:
            referencingIssues.length > 0
              ? `Runbook ${pageId}: inspect ${referencingIssues.slice(0, 3).join(", ")} before recovery.`
              : `Runbook ${pageId}: no recorded incidents reference this page.`,
        },
      ],
    },
    acl: restricted
      ? [
          {
            domain: "atlassian-group",
            principalId: "security",
            effect: "allow",
          },
        ]
      : [],
    sourceUpdatedAt: at(index),
    deleted: false,
  };
}

function issue(
  options: SyntheticCorpusOptions,
  index: number,
  plan: LinkPlan,
): SourceItem {
  const issueKey = `PAY-${index + 1}`;
  const subject = topic(options, issueKey);
  const pageId = plan.pageFor.get(issueKey) ?? pageIdAt(0);
  const codeId = plan.codeFor.get(issueKey) ?? codeIdAt(options, 0);
  const [repo = "service-0", path = "src/module-0.ts"] = codeId.split(":");
  return {
    sourceObjectId: issueKey,
    sourceVersion: "1",
    canonicalUri: `https://mock.atlassian.test/browse/${issueKey}`,
    title: `${subject} incident ${issueKey}`,
    body: `Investigate ${subject}; design reference ${pageId}.`,
    metadata: {
      issueKey,
      projectKey: "PAY",
      status: index % 7 === 0 ? "Done" : "Open",
      description: `Failure in ${subject}. See ${pageId} and ${repo}/${path}.`,
      comments: [
        {
          id: `${issueKey}-public`,
          author: "reporter",
          body: `Observed diagnostic code E${1000 + index}.`,
          createdAt: at(index),
        },
        {
          id: `${issueKey}-restricted`,
          author: "security-analyst",
          body: `Restricted root cause for ${subject}: credential boundary review.`,
          visibility: {
            domain: "jira-role",
            principalId: "service-desk-internal",
          },
          createdAt: at(index + 1),
        },
      ],
    },
    acl: [],
    sourceUpdatedAt: at(index),
    deleted: false,
  };
}

function codeFile(options: SyntheticCorpusOptions, index: number): SourceItem {
  const repositoryIndex = Math.floor(index / options.filesPerRepository);
  const fileIndex = index % options.filesPerRepository;
  const repository = `service-${repositoryIndex}`;
  const path = `src/module-${fileIndex}.ts`;
  const objectId = `${repository}:${path}`;
  const subject = topic(options, objectId);
  const symbol = `handle${subject
    .split(" ")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}${fileIndex}`;
  const body = `export function ${symbol}(attempt: number): string {\n  return attempt > 3 ? "exhausted" : "retry";\n}`;
  return {
    sourceObjectId: objectId,
    sourceVersion: `commit-${repositoryIndex}-1`,
    canonicalUri: `https://mock.bitbucket.test/projects/ENG/repos/${repository}/browse/${path}`,
    title: `${repository}/${path}`,
    body,
    metadata: {
      repository,
      ref: "main",
      path,
      language: "typescript",
      commitSha: createHash("sha1")
        .update(`${options.seed}:${objectId}`)
        .digest("hex"),
      generated: fileIndex % 23 === 0,
      symbols: [
        {
          name: symbol,
          kind: "function",
          startLine: 1,
          endLine: 3,
          text: body,
        },
      ],
    },
    acl: [],
    sourceUpdatedAt: at(index),
    deleted: false,
  };
}

function events(items: SourceItem[], mutations: boolean): StubEvent[] {
  const result = items.map((item, index) => ({ sequence: index + 1, item }));
  if (!mutations) return result;
  let sequence = result.length;
  for (const [index, item] of items.entries()) {
    if (index === 0 || index % 37 !== 0) continue;
    sequence += 1;
    result.push({
      sequence,
      item: {
        ...item,
        sourceVersion: "2",
        title: `${item.title} (updated)`,
        sourceUpdatedAt: at(sequence),
      },
    });
  }
  return result;
}

export function generateSyntheticCorpus(
  options: SyntheticCorpusOptions = syntheticCorpusPresets.ci,
): SyntheticCorpus {
  assertSize(options);
  const plan = planLinks(options);
  const pages = Array.from({ length: options.confluencePages }, (_, index) =>
    page(options, index, plan.issuesForPage.get(pageIdAt(index)) ?? []),
  );
  const issues = Array.from({ length: options.jiraIssues }, (_, index) =>
    issue(options, index, plan),
  );
  const code = Array.from(
    { length: options.repositories * options.filesPerRepository },
    (_, index) => codeFile(options, index),
  );
  const links: SyntheticLink[] = [];
  const relevance: SyntheticRelevanceJudgment[] = [];
  for (let index = 0; index < options.jiraIssues; index += 1) {
    const issueId = `PAY-${index + 1}`;
    // Same plan the documents were generated from. These previously recomputed
    // the modulo independently, so the graph links and the relevance labels
    // could disagree with what the documents actually referenced.
    const pageId = plan.pageFor.get(issueId);
    const codeId = plan.codeFor.get(issueId);
    if (pageId === undefined || codeId === undefined) continue;
    links.push(
      { from: issueId, to: pageId, type: "documents" },
      { from: issueId, to: codeId, type: "implemented-by" },
    );
    const subject = topic(options, issueId);

    // exact_lookup — the canonical key, nothing else. Truth is the one object
    // that key names. This family is expected to *fail* today: classify() does
    // extract `literal` for an issue key, but nothing consumes it, so there is
    // no identifier resolution path and the query falls through to token
    // search. Recording that honestly is the point.
    relevance.push({
      family: "exact_lookup",
      query: issueId,
      relevantSourceObjectIds: [issueId],
    });

    // subject_search — content only, no identifier and no ordinal.
    //
    // Truth is *every* document assigned this subject, computed from each
    // object's own key via seededIndex. It was previously the trio
    // [issue, pageFor(issue), codeFor(issue)] — but planLinks() chooses those
    // two from the same-subject cohort and also creates the graph edges, so the
    // truth was link-selected after all and measuring graph expansion against
    // it stayed circular. Subject membership is now independent of planLinks by
    // construction; `subjectMembers` never consults it.
    relevance.push({
      family: "subject_search",
      query: subject,
      relevantSourceObjectIds: subjectMembers(options, subject),
    });

    // relationship_navigation — given the issue, reach its neighbours. Graph
    // truth is legitimate here precisely because this is the task being
    // evaluated, rather than being folded into primary retrieval recall.
    relevance.push({
      family: "relationship_navigation",
      query: issueId,
      anchor: issueId,
      relevantSourceObjectIds: [pageId, codeId],
    });
  }

  // unanswerable — truth is absence, so the subject must appear on *no*
  // document of any kind. Checking only the issues would have been wrong: pages
  // and code are assigned subjects independently, so a subject unused by issues
  // can still be all over Confluence.
  //
  // Rather than hunt the vocabulary for leftovers — there are few, because
  // subjects are sized to be used — these are built one region beyond the
  // generated vocabulary. Absence then holds by construction rather than by
  // survey, and it stays true at any corpus size.
  const vocabulary = new Set(subjectVocabulary(options));
  const unansweredRegion =
    Math.ceil(vocabulary.size / (TOPICS.length * SUBSYSTEMS.length)) + 1;
  let unanswered = 0;
  for (const subject of TOPICS) {
    for (const subsystem of SUBSYSTEMS) {
      if (unanswered >= 20) break;
      const missing = `${subject} in ${subsystem} region-${unansweredRegion}`;
      if (vocabulary.has(missing)) continue;
      relevance.push({
        family: "unanswerable",
        query: `${missing} rollback procedure`,
        relevantSourceObjectIds: [],
      });
      unanswered += 1;
    }
  }

  // denied — an answer exists but this viewer may not see it. Every 20th page
  // is restricted to the security group, so querying its subject as an ordinary
  // viewer must return the same-subject alternatives and never the restricted
  // page itself. Zero leakage is the whole metric; recall is not.
  let denied = 0;
  for (let index = 0; index < options.confluencePages && denied < 20; index += 20) {
    const restrictedPage = pageIdAt(index);
    const subject = topic(options, restrictedPage);
    const authorized = subjectMembers(options, subject).filter(
      (id) => id !== restrictedPage,
    );
    relevance.push({
      family: "denied",
      query: subject,
      relevantSourceObjectIds: authorized,
      forbidden: [restrictedPage],
    });
    denied += 1;
  }
  return {
    seed: options.seed,
    events: {
      confluence: events(pages, true),
      jira: events(issues, true),
      git: events(code, true),
    },
    links,
    relevance,
    aclCases: [
      {
        sourceObjectId: "CONF-1",
        level: "resource",
        allowedPrincipal: "atlassian-group:security",
        deniedPrincipal: "atlassian-group:engineering",
      },
      {
        sourceObjectId: "PAY-1",
        level: "chunk",
        allowedPrincipal: "jira-role:service-desk-internal",
        deniedPrincipal: "atlassian-group:engineering",
      },
    ],
    containerAces: {
      "confluence:ENG": [
        {
          domain: "atlassian-group",
          principalId: "engineering",
          effect: "allow",
        },
      ],
      "confluence:SEC": [
        { domain: "atlassian-group", principalId: "security", effect: "allow" },
      ],
      "jira:PAY": [
        {
          domain: "atlassian-group",
          principalId: "engineering",
          effect: "allow",
        },
      ],
      ...Object.fromEntries(
        Array.from({ length: options.repositories }, (_, index) => [
          `git:service-${index}`,
          [
            {
              domain: "bitbucket-group",
              principalId: "engineering",
              effect: "allow",
            },
          ],
        ]),
      ),
    },
  };
}

export function syntheticCorpusCounts(
  corpus: SyntheticCorpus,
): Record<string, number> {
  return {
    confluenceEvents: corpus.events.confluence.length,
    jiraEvents: corpus.events.jira.length,
    gitEvents: corpus.events.git.length,
    links: corpus.links.length,
    relevanceJudgments: corpus.relevance.length,
    aclCases: corpus.aclCases.length,
  };
}
