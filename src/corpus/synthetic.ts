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

export interface SyntheticRelevanceJudgment {
  query: string;
  relevantSourceObjectIds: string[];
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
  return TOPICS[seededIndex(options.seed, key, TOPICS.length)] ?? TOPICS[0];
}

function at(index: number): string {
  return new Date(
    Date.UTC(2026, 0, 1, 0, index % 24, index % 60),
  ).toISOString();
}

function page(options: SyntheticCorpusOptions, index: number): SourceItem {
  const pageId = `CONF-${index + 1}`;
  const subject = topic(options, pageId);
  const restricted = index % 20 === 0;
  return {
    sourceObjectId: pageId,
    sourceVersion: "1",
    canonicalUri: `https://mock.atlassian.test/wiki/spaces/ENG/pages/${index + 1}`,
    title: `${subject} design ${index + 1}`,
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
          text: `Runbook ${index + 1}: inspect PAY-${(index % options.jiraIssues) + 1} before recovery.`,
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

function issue(options: SyntheticCorpusOptions, index: number): SourceItem {
  const issueKey = `PAY-${index + 1}`;
  const subject = topic(options, issueKey);
  const pageId = `CONF-${(index % options.confluencePages) + 1}`;
  const repo = `service-${index % options.repositories}`;
  const path = `src/module-${index % options.filesPerRepository}.ts`;
  return {
    sourceObjectId: issueKey,
    sourceVersion: "1",
    canonicalUri: `https://mock.atlassian.test/browse/${issueKey}`,
    title: `${subject} incident ${index + 1}`,
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
          body: `Restricted root cause for ${subject}: credential boundary ${index}.`,
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
  const pages = Array.from({ length: options.confluencePages }, (_, index) =>
    page(options, index),
  );
  const issues = Array.from({ length: options.jiraIssues }, (_, index) =>
    issue(options, index),
  );
  const code = Array.from(
    { length: options.repositories * options.filesPerRepository },
    (_, index) => codeFile(options, index),
  );
  const links: SyntheticLink[] = [];
  const relevance: SyntheticRelevanceJudgment[] = [];
  for (let index = 0; index < options.jiraIssues; index += 1) {
    const issueId = `PAY-${index + 1}`;
    const pageId = `CONF-${(index % options.confluencePages) + 1}`;
    const codeId = `service-${index % options.repositories}:src/module-${index % options.filesPerRepository}.ts`;
    links.push(
      { from: issueId, to: pageId, type: "documents" },
      { from: issueId, to: codeId, type: "implemented-by" },
    );
    relevance.push({
      query: `${topic(options, issueId)} incident ${index + 1}`,
      relevantSourceObjectIds: [issueId, pageId, codeId],
    });
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
