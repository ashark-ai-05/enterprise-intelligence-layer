/**
 * Live Confluence and Jira search adapters.
 *
 * Adapted from `reference/sonnet-p0-federated-search`. Placed under
 * `src/federated/` rather than `src/connectors/`: an ingestion connector and a
 * federated search adapter are different things that would otherwise share a
 * directory name, and `src/connectors/` belongs to the ingestion lane.
 *
 * ACL correctness is free here — the source enforces its own permissions on its
 * own search endpoint — which is exactly what makes this arm the drift oracle
 * once an indexed arm runs beside it.
 *
 * Results come back in the source's own order. Rank is implied by array
 * position; RRF consumes ranks, so no score ever crosses a source boundary.
 */

import type { SourceAdapter, SourceResult } from "./arm.js";
import { buildConfluenceCql, buildJiraJql } from "./query-language.js";

/**
 * Minimal fetch shape, injectable so adapters are unit-testable with no network.
 *
 * Proxy routing is not this module's business: `installGlobalProxy()` sets the
 * dispatcher once at startup and `fetch` honours it. → src/net/proxy.ts
 */
export type FetchLike = (
  url: string,
  init: { headers?: Record<string, string> | undefined },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    statusText: string,
  ) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.name = "HttpError";
  }
}

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<T> {
  const response = await fetchImpl(url, { headers });
  if (!response.ok)
    throw new HttpError(response.status, url, response.statusText);
  return (await response.json()) as T;
}

export interface AdapterConfig {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly limit?: number;
}

export interface ConfluenceAdapterConfig extends AdapterConfig {
  readonly spaceKeys?: readonly string[];
}

export interface JiraAdapterConfig extends AdapterConfig {
  readonly projectKeys?: readonly string[];
}

const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
});

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

interface ConfluenceSearchResponse {
  results: {
    id: string;
    title: string;
    excerpt?: string;
    space?: { key?: string };
    version?: { when?: string };
    _links: { webui: string; base?: string };
  }[];
}

export class ConfluenceAdapter implements SourceAdapter {
  readonly name = "confluence";

  constructor(
    private readonly config: ConfluenceAdapterConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}

  async search(
    query: string,
    options: { limit?: number | undefined } = {},
  ): Promise<SourceResult[]> {
    const limit = options.limit ?? this.config.limit ?? 20;
    const cql = buildConfluenceCql(query, this.config.spaceKeys ?? []);
    const base = trimSlash(this.config.baseUrl);
    const url = `${base}/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`;

    const response = await getJson<ConfluenceSearchResponse>(
      url,
      bearer(this.config.authToken),
      this.fetchImpl,
    );

    return response.results.map((item) => ({
      id: item.id,
      source: this.name,
      title: item.title,
      snippet: item.excerpt ?? "",
      url: `${item._links.base ?? base}${item._links.webui}`,
      updatedAt: item.version?.when ?? new Date(0).toISOString(),
      // Container is the ACL pre-filter key. An unknown space would silently
      // widen or narrow visibility, so it is marked rather than guessed.
      container: item.space?.key ?? "unknown",
    }));
  }
}

interface JiraSearchResponse {
  issues: {
    key: string;
    fields: {
      summary?: string;
      description?: string | null;
      updated?: string;
      project?: { key?: string };
    };
  }[];
}

export class JiraAdapter implements SourceAdapter {
  readonly name = "jira";

  constructor(
    private readonly config: JiraAdapterConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}

  async search(
    query: string,
    options: { limit?: number | undefined } = {},
  ): Promise<SourceResult[]> {
    const limit = options.limit ?? this.config.limit ?? 20;
    const jql = buildJiraJql(query, this.config.projectKeys ?? []);
    const base = trimSlash(this.config.baseUrl);
    const url =
      `${base}/rest/api/2/search?jql=${encodeURIComponent(jql)}` +
      `&maxResults=${limit}&fields=summary,description,updated,project`;

    const response = await getJson<JiraSearchResponse>(
      url,
      bearer(this.config.authToken),
      this.fetchImpl,
    );

    return response.issues.map((issue) => ({
      id: issue.key,
      source: this.name,
      title: issue.fields.summary ?? issue.key,
      snippet: (issue.fields.description ?? "").slice(0, 300),
      url: `${base}/browse/${issue.key}`,
      updatedAt: issue.fields.updated ?? new Date(0).toISOString(),
      container: issue.fields.project?.key ?? "unknown",
    }));
  }
}

/** Build the adapters the environment is configured for. Absent config means absent adapter, not an error. */
export function adaptersFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: FetchLike,
): SourceAdapter[] {
  const adapters: SourceAdapter[] = [];

  const confluenceUrl = env.EIL_CONFLUENCE_URL;
  const confluenceToken = env.EIL_CONFLUENCE_TOKEN;
  if (confluenceUrl !== undefined && confluenceToken !== undefined) {
    adapters.push(
      new ConfluenceAdapter(
        {
          baseUrl: confluenceUrl,
          authToken: confluenceToken,
          spaceKeys: (env.EIL_CONFLUENCE_SPACES ?? "")
            .split(",")
            .filter(Boolean),
        },
        fetchImpl,
      ),
    );
  }

  const jiraUrl = env.EIL_JIRA_URL;
  const jiraToken = env.EIL_JIRA_TOKEN;
  if (jiraUrl !== undefined && jiraToken !== undefined) {
    adapters.push(
      new JiraAdapter(
        {
          baseUrl: jiraUrl,
          authToken: jiraToken,
          projectKeys: (env.EIL_JIRA_PROJECTS ?? "").split(",").filter(Boolean),
        },
        fetchImpl,
      ),
    );
  }

  return adapters;
}
