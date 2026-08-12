import type { IngestionScope } from "../scopes/types.js";
import type {
  AccessControlEntry,
  ConnectorBatch,
  ConnectorCursor,
  SourceConnector,
  SourceItem,
} from "./types.js";

type Fetch = typeof fetch;

export interface ConfluenceConnectorOptions {
  baseUrl: string;
  token: string;
  principal: string;
  email?: string;
  fetch?: Fetch;
  pageSize?: number;
}

interface Page extends Record<string, unknown> {
  id: string;
  title: string;
  type?: string;
  _links?: { webui?: string; base?: string };
  body?: { storage?: { value?: string } };
  version?: { number?: number; when?: string };
  history?: { lastUpdated?: { number?: number; when?: string } };
  space?: { key?: string; name?: string };
  restrictions?: unknown;
}

interface PageResult extends Record<string, unknown> {
  results?: Page[];
  start?: number;
  limit?: number;
  size?: number;
  _links?: { next?: string };
}

function strings(selector: Record<string, unknown>, key: string): string[] {
  const value = selector[key];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function cqlDate(value: Date): string {
  return value.toISOString().slice(0, 16).replace("T", " ");
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/li>|<\/tr>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
      if (entity.startsWith("#x"))
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#"))
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return entities[entity.toLowerCase()] ?? `&${entity};`;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function sections(storage: string): Record<string, unknown>[] {
  const parts = storage.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/gi);
  const output: Record<string, unknown>[] = [];
  let heading = "Overview";
  let buffer = "";
  const flush = () => {
    const text = decodeHtml(buffer);
    if (text) {
      output.push({
        anchor:
          heading
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || `section-${output.length}`,
        headingPath: [heading],
        text,
      });
    }
    buffer = "";
  };
  for (const part of parts) {
    if (/^<h[1-6]/i.test(part)) {
      flush();
      heading = decodeHtml(part) || "Untitled";
    } else {
      buffer += part;
    }
  }
  flush();
  return output;
}

function nestedResults(
  value: unknown,
  key: "user" | "group",
): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const read = object.read as Record<string, unknown> | undefined;
  const restrictions = (read?.restrictions ??
    object.restrictions ??
    object) as Record<string, unknown>;
  const collection = restrictions[key] as Record<string, unknown> | undefined;
  return Array.isArray(collection?.results)
    ? collection.results.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object",
      )
    : [];
}

function pageAcl(page: Page, principal: string): AccessControlEntry[] {
  const users = nestedResults(page.restrictions, "user").flatMap((user) => {
    const id = user.accountId ?? user.userKey ?? user.username;
    return typeof id === "string"
      ? [
          {
            domain: "confluence-user",
            principalId: id,
            effect: "allow" as const,
          },
        ]
      : [];
  });
  const groups = nestedResults(page.restrictions, "group").flatMap((group) => {
    const id = group.id ?? group.name;
    return typeof id === "string"
      ? [
          {
            domain: "confluence-group",
            principalId: id,
            effect: "allow" as const,
          },
        ]
      : [];
  });
  // This connector is deliberately personal-mode: a successful authoritative
  // fetch proves the configured source identity may read the page now. Keep
  // the source restrictions as provenance for the future shared identity
  // resolver, while granting only that configured identity locally.
  return [
    { domain: "confluence-user", principalId: principal, effect: "allow" },
    ...users,
    ...groups,
  ];
}

export class ConfluenceConnector implements SourceConnector {
  readonly name = "live-confluence";
  readonly source = "confluence" as const;
  private readonly baseUrl: string;
  private readonly fetcher: Fetch;
  private readonly headers: Record<string, string>;
  private readonly pageSize: number;

  constructor(private readonly options: ConfluenceConnectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
    this.pageSize = options.pageSize ?? 100;
    if (!this.baseUrl || !options.token || !options.principal) {
      throw new Error("Confluence URL, token, and principal are required");
    }
    this.headers = {
      Accept: "application/json",
      Authorization: options.email
        ? `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`
        : `Bearer ${options.token}`,
    };
  }

  private async json<T>(path: string): Promise<T> {
    const response = await this.fetcher(new URL(path, `${this.baseUrl}/`), {
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(
        `Confluence ${response.status} ${response.statusText}: ${body}`,
      );
    }
    return (await response.json()) as T;
  }

  private expand(): string {
    return "body.storage,version,history.lastUpdated,space,restrictions.read.restrictions.user,restrictions.read.restrictions.group";
  }

  private async fetchPage(id: string): Promise<Page | null> {
    const response = await this.fetcher(
      new URL(
        `rest/api/content/${encodeURIComponent(id)}?expand=${encodeURIComponent(this.expand())}`,
        `${this.baseUrl}/`,
      ),
      { headers: this.headers, signal: AbortSignal.timeout(30_000) },
    );
    // Forbidden and absent deliberately collapse to the same result. Besides
    // avoiding an existence leak, this lets reconciliation revoke a page when
    // the configured personal identity loses access.
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Confluence ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    return (await response.json()) as Page;
  }

  private async listSpace(
    spaceKey: string,
    updatedAfter?: Date,
  ): Promise<Page[]> {
    const pages: Page[] = [];
    let start = 0;
    for (;;) {
      const clauses = [
        `space = "${spaceKey.replace(/["\\]/g, "\\$&")}"`,
        "type = page",
      ];
      if (updatedAfter)
        clauses.push(`lastmodified >= "${cqlDate(updatedAfter)}"`);
      const params = new URLSearchParams({
        cql: clauses.join(" AND "),
        expand: this.expand(),
        limit: String(this.pageSize),
        start: String(start),
      });
      const result = await this.json<PageResult>(
        `rest/api/content/search?${params}`,
      );
      const batch = result.results ?? [];
      pages.push(...batch);
      if (!result._links?.next) break;
      start += batch.length;
      if (batch.length === 0) break;
    }
    return pages;
  }

  private toItem(page: Page): SourceItem {
    const storage = page.body?.storage?.value ?? "";
    const updated =
      page.version?.when ??
      page.history?.lastUpdated?.when ??
      new Date(0).toISOString();
    const version =
      page.version?.number ?? page.history?.lastUpdated?.number ?? updated;
    const webui =
      page._links?.webui ?? `/pages/viewpage.action?pageId=${page.id}`;
    const uri = new URL(
      webui,
      page._links?.base ?? `${this.baseUrl}/`,
    ).toString();
    const spaceKey = page.space?.key ?? "unknown";
    return {
      sourceObjectId: page.id,
      sourceVersion: String(version),
      canonicalUri: uri,
      title: page.title,
      body: decodeHtml(storage),
      metadata: {
        pageId: page.id,
        spaceKey,
        containerId: spaceKey,
        containerName: page.space?.name ?? spaceKey,
        containerAcl: [
          {
            domain: "confluence-user",
            principalId: this.options.principal,
            effect: "allow",
          },
        ],
        sections: sections(storage),
      },
      acl: pageAcl(page, this.options.principal),
      sourceUpdatedAt: new Date(updated).toISOString(),
      deleted: false,
    };
  }

  async read(
    scope: IngestionScope,
    cursor: ConnectorCursor | null,
  ): Promise<ConnectorBatch> {
    const pages: Page[] = [];
    if (scope.selectorKind === "page") {
      for (const id of strings(scope.selector, "ids")) {
        const page = await this.fetchPage(id);
        if (page) pages.push(page);
      }
    } else if (scope.selectorKind === "space") {
      const updatedAfter = cursor ? new Date(cursor.sequence) : undefined;
      for (const key of strings(scope.selector, "keys")) {
        pages.push(...(await this.listSpace(key, updatedAfter)));
      }
    } else {
      throw new Error(`unsupported Confluence selector: ${scope.selectorKind}`);
    }
    const items = pages.map((page) => this.toItem(page));
    const sequence = items.reduce(
      (latest, item) => Math.max(latest, Date.parse(item.sourceUpdatedAt)),
      cursor?.sequence ?? 0,
    );
    return { items, nextCursor: { sequence }, complete: true };
  }

  async listCurrentIds(scope: IngestionScope): Promise<string[]> {
    if (scope.selectorKind === "page") {
      const ids: string[] = [];
      for (const id of strings(scope.selector, "ids")) {
        if (await this.fetchPage(id)) ids.push(id);
      }
      return ids.sort();
    }
    if (scope.selectorKind !== "space") {
      throw new Error(`unsupported Confluence selector: ${scope.selectorKind}`);
    }
    const ids: string[] = [];
    for (const key of strings(scope.selector, "keys")) {
      ids.push(...(await this.listSpace(key)).map((page) => page.id));
    }
    return [...new Set(ids)].sort();
  }
}

export function confluenceConnectorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: Fetch,
): ConfluenceConnector {
  const baseUrl = env.EIL_CONFLUENCE_URL;
  const token = env.EIL_CONFLUENCE_TOKEN;
  const principal = env.EIL_CONFLUENCE_PRINCIPAL ?? env.EIL_CONFLUENCE_EMAIL;
  if (!baseUrl || !token || !principal) {
    throw new Error(
      "Live Confluence requires EIL_CONFLUENCE_URL, EIL_CONFLUENCE_TOKEN, and EIL_CONFLUENCE_PRINCIPAL (or EIL_CONFLUENCE_EMAIL)",
    );
  }
  return new ConfluenceConnector({
    baseUrl,
    token,
    principal,
    ...(env.EIL_CONFLUENCE_EMAIL ? { email: env.EIL_CONFLUENCE_EMAIL } : {}),
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}
