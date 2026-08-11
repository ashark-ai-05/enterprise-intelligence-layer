import { describe, expect, it } from "vitest";
import {
  ConfluenceAdapter,
  type FetchLike,
  HttpError,
  JiraAdapter,
  adaptersFromEnv,
} from "../src/federated/adapters.js";
import {
  buildConfluenceCql,
  buildJiraJql,
  escapeIdentifier,
  escapeTextSearch,
} from "../src/federated/query-language.js";

/** Records the URL it was called with and replays a canned body. */
const stubFetch = (
  body: unknown,
  status = 200,
): FetchLike & { calls: string[] } => {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
    };
  };
  return Object.assign(impl, { calls });
};

describe("escapeTextSearch", () => {
  it("escapes the string-literal delimiters", () => {
    expect(escapeTextSearch('say "hi"')).toContain('\\"');
    expect(escapeTextSearch("back\\slash")).toContain("\\\\");
  });

  it("escapes Lucene operators that would otherwise change the query", () => {
    // Without this a search for `retry?` is a wildcard, `C++` is a parse error,
    // and `foo:bar` is a field query. Users read all three as "search is broken".
    expect(escapeTextSearch("retry?")).toBe("retry\\?");
    expect(escapeTextSearch("C++")).toBe("C\\+\\+");
    expect(escapeTextSearch("foo:bar")).toBe("foo\\:bar");
    expect(escapeTextSearch("cost^2")).toBe("cost\\^2");
    expect(escapeTextSearch("a[1]")).toBe("a\\[1\\]");
  });

  it("escapes the paired boolean operators", () => {
    expect(escapeTextSearch("a && b")).toBe("a \\&\\& b");
    expect(escapeTextSearch("a || b")).toBe("a \\|\\| b");
  });

  it("neutralises bare uppercase boolean keywords without changing what matches", () => {
    // Text search is case-insensitive, so lower-casing costs nothing.
    expect(escapeTextSearch("cats AND dogs")).toBe("cats and dogs");
    expect(escapeTextSearch("cats NOT dogs")).toBe("cats not dogs");
  });

  it("leaves an ordinary query alone", () => {
    expect(escapeTextSearch("payment retry policy")).toBe(
      "payment retry policy",
    );
  });
});

describe("escapeIdentifier", () => {
  it("escapes quotes and backslashes so a key cannot break out of its literal", () => {
    expect(escapeIdentifier('AR"CH')).toBe('AR\\"CH');
  });
});

describe("buildConfluenceCql", () => {
  it("restricts to pages", () => {
    expect(buildConfluenceCql("retry")).toContain("type = page");
  });

  it("scopes to the configured spaces", () => {
    expect(buildConfluenceCql("retry", ["ARCH", "PLAT"])).toContain(
      'space in ("ARCH","PLAT")',
    );
  });

  it("omits the space clause when none are configured", () => {
    expect(buildConfluenceCql("retry")).not.toContain("space in");
  });

  it("escapes the query rather than interpolating it raw", () => {
    expect(buildConfluenceCql('a" or type = blogpost')).toContain('\\"');
  });
});

describe("buildJiraJql", () => {
  it("scopes to the configured projects", () => {
    expect(buildJiraJql("retry", ["PHX"])).toContain('project in ("PHX")');
  });

  it("orders by recency, leaving relevance to RRF", () => {
    expect(buildJiraJql("retry")).toContain("order by updated desc");
  });

  it("escapes the query", () => {
    expect(buildJiraJql("C++")).toContain("C\\+\\+");
  });
});

describe("ConfluenceAdapter", () => {
  const body = {
    results: [
      {
        id: "12345",
        title: "Payment retry policy",
        excerpt: "Payments retry three times",
        space: { key: "ARCH" },
        version: { when: "2026-08-01T10:00:00Z" },
        _links: {
          webui: "/spaces/ARCH/pages/12345",
          base: "https://wiki.example.invalid",
        },
      },
    ],
  };

  it("maps a search response into source results", async () => {
    const fetchImpl = stubFetch(body);
    const adapter = new ConfluenceAdapter(
      { baseUrl: "https://wiki.example.invalid", authToken: "t" },
      fetchImpl,
    );
    const [result] = await adapter.search("payment retry");
    expect(result).toMatchObject({
      id: "12345",
      source: "confluence",
      title: "Payment retry policy",
      container: "ARCH",
      url: "https://wiki.example.invalid/spaces/ARCH/pages/12345",
    });
  });

  it("sends the CQL and the limit", async () => {
    const fetchImpl = stubFetch(body);
    const adapter = new ConfluenceAdapter(
      {
        baseUrl: "https://wiki.example.invalid",
        authToken: "t",
        spaceKeys: ["ARCH"],
      },
      fetchImpl,
    );
    await adapter.search("retry", { limit: 5 });
    const url = decodeURIComponent(fetchImpl.calls[0] ?? "");
    expect(url).toContain('space in ("ARCH")');
    expect(fetchImpl.calls[0]).toContain("limit=5");
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const fetchImpl = stubFetch(body);
    const adapter = new ConfluenceAdapter(
      { baseUrl: "https://wiki.example.invalid/", authToken: "t" },
      fetchImpl,
    );
    await adapter.search("retry");
    expect(fetchImpl.calls[0]).not.toContain("//rest");
  });

  it("marks an unknown space rather than guessing one", async () => {
    // Container is the ACL pre-filter key; a guess would widen or narrow
    // visibility silently.
    const fetchImpl = stubFetch({
      results: [{ ...body.results[0], space: undefined }],
    });
    const adapter = new ConfluenceAdapter(
      { baseUrl: "https://x.invalid", authToken: "t" },
      fetchImpl,
    );
    const [result] = await adapter.search("retry");
    expect(result?.container).toBe("unknown");
  });

  it("throws a typed error carrying the status", async () => {
    const adapter = new ConfluenceAdapter(
      { baseUrl: "https://x.invalid", authToken: "t" },
      stubFetch({}, 401),
    );
    await expect(adapter.search("retry")).rejects.toBeInstanceOf(HttpError);
  });
});

describe("JiraAdapter", () => {
  const body = {
    issues: [
      {
        key: "PHX-4471",
        fields: {
          summary: "Retry policy misconfigured",
          description: "Long description",
          updated: "2026-08-02T09:00:00Z",
          project: { key: "PHX" },
        },
      },
    ],
  };

  it("maps issues into source results keyed by issue key", async () => {
    const adapter = new JiraAdapter(
      { baseUrl: "https://jira.invalid", authToken: "t" },
      stubFetch(body),
    );
    const [result] = await adapter.search("retry");
    expect(result).toMatchObject({
      id: "PHX-4471",
      source: "jira",
      container: "PHX",
      url: "https://jira.invalid/browse/PHX-4471",
    });
  });

  it("falls back to the key when an issue has no summary", async () => {
    const adapter = new JiraAdapter(
      { baseUrl: "https://jira.invalid", authToken: "t" },
      stubFetch({ issues: [{ key: "PHX-1", fields: {} }] }),
    );
    const [result] = await adapter.search("retry");
    expect(result?.title).toBe("PHX-1");
  });

  it("requests only the fields it uses", async () => {
    const fetchImpl = stubFetch(body);
    const adapter = new JiraAdapter(
      { baseUrl: "https://jira.invalid", authToken: "t" },
      fetchImpl,
    );
    await adapter.search("retry");
    expect(fetchImpl.calls[0]).toContain(
      "fields=summary,description,updated,project",
    );
  });

  it("bounds the snippet so a huge description cannot dominate a response", async () => {
    const adapter = new JiraAdapter(
      { baseUrl: "https://jira.invalid", authToken: "t" },
      stubFetch({
        issues: [{ key: "PHX-1", fields: { description: "x".repeat(5000) } }],
      }),
    );
    const [result] = await adapter.search("retry");
    expect(result?.snippet.length).toBe(300);
  });
});

describe("adaptersFromEnv", () => {
  it("builds nothing when nothing is configured", () => {
    expect(adaptersFromEnv({})).toEqual([]);
  });

  it("builds only the adapters that have both a URL and a token", () => {
    const adapters = adaptersFromEnv({
      EIL_CONFLUENCE_URL: "https://wiki.invalid",
      EIL_CONFLUENCE_TOKEN: "t",
      EIL_JIRA_URL: "https://jira.invalid", // no token
    });
    expect(adapters.map((adapter) => adapter.name)).toEqual(["confluence"]);
  });

  it("parses the scope lists", async () => {
    const fetchImpl = stubFetch({ results: [] });
    const [adapter] = adaptersFromEnv(
      {
        EIL_CONFLUENCE_URL: "https://wiki.invalid",
        EIL_CONFLUENCE_TOKEN: "t",
        EIL_CONFLUENCE_SPACES: "ARCH,PLAT",
      },
      fetchImpl,
    );
    await adapter?.search("retry");
    expect(decodeURIComponent(fetchImpl.calls[0] ?? "")).toContain(
      'space in ("ARCH","PLAT")',
    );
  });
});
