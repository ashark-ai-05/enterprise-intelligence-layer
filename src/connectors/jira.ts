import type { IngestionScope } from "../scopes/types.js";
import type {
  AccessControlEntry,
  ConnectorBatch,
  ConnectorCursor,
  SourceConnector,
  SourceItem,
} from "./types.js";

type Fetch = typeof fetch;

export interface JiraConnectorOptions {
  baseUrl: string;
  token: string;
  principal: string;
  email?: string;
  fetch?: Fetch;
  pageSize?: number;
}

interface Comment extends Record<string, unknown> {
  id?: string;
  author?: { displayName?: string; accountId?: string; name?: string };
  body?: string;
  created?: string;
  visibility?: { type?: string; value?: string };
}

interface Issue extends Record<string, unknown> {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: string;
    updated?: string;
    created?: string;
    project?: { key?: string; name?: string };
    comment?: { comments?: Comment[] };
    security?: { id?: string; name?: string };
  };
}

interface SearchResult extends Record<string, unknown> {
  issues?: Issue[];
  startAt?: number;
  maxResults?: number;
  total?: number;
}

function strings(selector: Record<string, unknown>, key: string): string[] {
  const value = selector[key];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function jqlString(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** JQL date comparisons want "yyyy-MM-dd HH:mm", not ISO 8601. */
function jqlDate(value: Date): string {
  return value.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Jira's comment visibility restricts one comment to a role or group — the
 * same subtractive shape Confluence page restrictions have, at chunk rather
 * than resource granularity. `{type, value}` maps onto the connector-neutral
 * `{domain, principalId}}` the Jira normalizer already reads (see
 * src/normalization/normalizers.ts) — this connector does not invent a new
 * chunk-ACL vocabulary, it feeds the one that exists.
 */
function commentVisibility(
  comment: Comment,
): { domain: string; principalId: string } | undefined {
  const visibility = comment.visibility;
  if (!visibility?.type || !visibility.value) return undefined;
  return {
    domain: visibility.type === "role" ? "jira-role" : "jira-group",
    principalId: visibility.value,
  };
}

function issueAcl(issue: Issue, principal: string): AccessControlEntry[] {
  const security = issue.fields?.security;
  // A configured issue security level is a resource-level override, the same
  // shape Confluence page restrictions take: presence of any allow entry
  // narrows visibility to exactly those entries, so the always-included
  // configured principal is what keeps the connector's own fetch consistent
  // with what it is about to grant locally.
  const securityEntry: AccessControlEntry[] = security?.name
    ? [
        {
          domain: "jira-security-level",
          principalId: security.name,
          effect: "allow",
        },
      ]
    : [];
  return [
    { domain: "jira-user", principalId: principal, effect: "allow" },
    ...securityEntry,
  ];
}

export class JiraConnector implements SourceConnector {
  readonly name = "live-jira";
  readonly source = "jira" as const;
  private readonly baseUrl: string;
  private readonly fetcher: Fetch;
  private readonly headers: Record<string, string>;
  private readonly pageSize: number;

  constructor(private readonly options: JiraConnectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
    this.pageSize = options.pageSize ?? 100;
    if (!this.baseUrl || !options.token || !options.principal) {
      throw new Error("Jira URL, token, and principal are required");
    }
    this.headers = {
      Accept: "application/json",
      Authorization: options.email
        ? `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`
        : `Bearer ${options.token}`,
    };
  }

  private fields(): string {
    return "summary,description,updated,created,project,comment,security";
  }

  private async fetchIssue(key: string): Promise<Issue | null> {
    const response = await this.fetcher(
      new URL(
        `rest/api/2/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(this.fields())}`,
        `${this.baseUrl}/`,
      ),
      { headers: this.headers, signal: AbortSignal.timeout(30_000) },
    );
    // Forbidden and absent deliberately collapse to the same result, matching
    // the Confluence connector: besides avoiding an existence leak, this lets
    // reconciliation revoke an issue when the configured identity loses
    // access to it (e.g. an issue security level narrows after ingest).
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Jira ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    return (await response.json()) as Issue;
  }

  private async searchProjects(
    projectKeys: string[],
    updatedAfter?: Date,
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    const clauses = [
      `project in (${projectKeys.map((key) => `"${jqlString(key)}"`).join(",")})`,
    ];
    if (updatedAfter) clauses.push(`updated >= "${jqlDate(updatedAfter)}"`);
    let startAt = 0;
    for (;;) {
      const params = new URLSearchParams({
        jql: clauses.join(" AND "),
        fields: this.fields(),
        maxResults: String(this.pageSize),
        startAt: String(startAt),
      });
      const result = await this.json<SearchResult>(
        `rest/api/2/search?${params}`,
      );
      const batch = result.issues ?? [];
      issues.push(...batch);
      const total = result.total ?? issues.length;
      startAt += batch.length;
      if (batch.length === 0 || startAt >= total) break;
    }
    return issues;
  }

  private async json<T>(path: string): Promise<T> {
    const response = await this.fetcher(new URL(path, `${this.baseUrl}/`), {
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(
        `Jira ${response.status} ${response.statusText}: ${body}`,
      );
    }
    return (await response.json()) as T;
  }

  private toItem(issue: Issue): SourceItem {
    const fields = issue.fields ?? {};
    const updated =
      fields.updated ?? fields.created ?? new Date(0).toISOString();
    const projectKey = fields.project?.key ?? "unknown";
    const comments = (fields.comment?.comments ?? []).map((comment) => {
      const visibility = commentVisibility(comment);
      return {
        id: comment.id ?? "",
        body: comment.body ?? "",
        ...(comment.author?.displayName
          ? { author: comment.author.displayName }
          : {}),
        ...(comment.created ? { createdAt: comment.created } : {}),
        ...(visibility ? { visibility } : {}),
      };
    });
    return {
      sourceObjectId: issue.key,
      sourceVersion: updated,
      canonicalUri: new URL(
        `browse/${issue.key}`,
        `${this.baseUrl}/`,
      ).toString(),
      title: fields.summary ?? issue.key,
      body: fields.description ?? "",
      metadata: {
        issueKey: issue.key,
        projectKey,
        containerId: projectKey,
        containerName: fields.project?.name ?? projectKey,
        containerAcl: [
          {
            domain: "jira-user",
            principalId: this.options.principal,
            effect: "allow",
          },
        ],
        description: fields.description ?? "",
        comments,
      },
      acl: issueAcl(issue, this.options.principal),
      sourceUpdatedAt: new Date(updated).toISOString(),
      deleted: false,
    };
  }

  async read(
    scope: IngestionScope,
    cursor: ConnectorCursor | null,
  ): Promise<ConnectorBatch> {
    let issues: Issue[];
    if (scope.selectorKind === "issues") {
      const keys = strings(scope.selector, "ids");
      const fetched = await Promise.all(
        keys.map((key) => this.fetchIssue(key)),
      );
      issues = fetched.filter((issue): issue is Issue => issue !== null);
    } else if (scope.selectorKind === "project") {
      const keys = strings(scope.selector, "keys");
      const updatedAfter = cursor ? new Date(cursor.sequence) : undefined;
      issues =
        keys.length === 0 ? [] : await this.searchProjects(keys, updatedAfter);
    } else {
      throw new Error(`unsupported Jira selector: ${scope.selectorKind}`);
    }
    const items = issues.map((issue) => this.toItem(issue));
    const sequence = items.reduce(
      (latest, item) => Math.max(latest, Date.parse(item.sourceUpdatedAt)),
      cursor?.sequence ?? 0,
    );
    return { items, nextCursor: { sequence }, complete: true };
  }

  async listCurrentIds(scope: IngestionScope): Promise<string[]> {
    if (scope.selectorKind === "issues") {
      const keys = strings(scope.selector, "ids");
      const present = await Promise.all(
        keys.map(async (key) => ((await this.fetchIssue(key)) ? key : null)),
      );
      return present.filter((key): key is string => key !== null).sort();
    }
    if (scope.selectorKind !== "project") {
      throw new Error(`unsupported Jira selector: ${scope.selectorKind}`);
    }
    const keys = strings(scope.selector, "keys");
    if (keys.length === 0) return [];
    const issues = await this.searchProjects(keys);
    return [...new Set(issues.map((issue) => issue.key))].sort();
  }
}

export function jiraConnectorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: Fetch,
): JiraConnector {
  const baseUrl = env.EIL_JIRA_URL;
  const token = env.EIL_JIRA_TOKEN;
  const principal = env.EIL_JIRA_PRINCIPAL ?? env.EIL_JIRA_EMAIL;
  if (!baseUrl || !token || !principal) {
    throw new Error(
      "Live Jira requires EIL_JIRA_URL, EIL_JIRA_TOKEN, and EIL_JIRA_PRINCIPAL (or EIL_JIRA_EMAIL)",
    );
  }
  return new JiraConnector({
    baseUrl,
    token,
    principal,
    ...(env.EIL_JIRA_EMAIL ? { email: env.EIL_JIRA_EMAIL } : {}),
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}
