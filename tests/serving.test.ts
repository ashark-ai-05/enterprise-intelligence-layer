import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_TENANT,
  type SeedResult,
  defaultArms,
  evalViewer,
  seedEvaluationCorpus,
} from "../src/eval/corpus-gate.js";
import {
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  handleLine,
  handleRequest,
  serveStdio,
} from "../src/serving/mcp-stdio.js";
import {
  InMemoryAuditSink,
  PROVENANCE_NOTICE,
  TOOLS,
  type ToolContext,
  ToolError,
  callTool,
} from "../src/serving/tools.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

let db: Database;
let seed: SeedResult;
let audit: InMemoryAuditSink;
let context: ToolContext;

// Seeded once: no test in this file mutates the corpus, and re-ingesting 310
// resources per test cost ~150s of CI for nothing.
beforeAll(async () => {
  db = await testDatabase();
  seed = await seedEvaluationCorpus(db);
}, 180_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  audit = new InMemoryAuditSink();
  context = {
    db,
    tenantId: EVAL_TENANT,
    arms: defaultArms(db),
    viewer: evalViewer(seed.containerIds),
    audit,
  };
});

const parse = (content: string) => JSON.parse(content) as Record<string, never>;

describe("tool surface", () => {
  it("exposes no write tools", () => {
    // Mutations stay with the source systems, where the audit trail and the
    // permission model already exist.
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      "search_enterprise",
      "lookup_object",
      "related_evidence",
      "get_evidence",
      "list_containers",
      "get_freshness",
    ]);
  });

  it("accepts no principal, group or container argument on any tool", () => {
    // A caller who could name their own principals would be authorising
    // themselves. The viewer is derived, never supplied.
    for (const tool of TOOLS) {
      const properties = Object.keys(
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      for (const forbidden of [
        "principal",
        "principals",
        "groups",
        "containers",
        "viewer",
        "tenant",
      ]) {
        expect(properties).not.toContain(forbidden);
      }
    }
  });

  it("rejects an unknown tool", async () => {
    await expect(
      callTool("drop_everything", {}, context),
    ).rejects.toBeInstanceOf(ToolError);
  });
});

describe("exact lookup and related evidence", () => {
  it("resolves an exact id without text ranking", async () => {
    const payload = parse(
      (await callTool("lookup_object", { id: "PAY-1" }, context)).content,
    ) as unknown as { found: boolean; hit: { id: string } };
    expect(payload.found).toBe(true);
    expect(payload.hit.id).toBe("PAY-1");
  });

  it("does not distinguish a forbidden anchor from a missing one", async () => {
    const blind: ToolContext = {
      ...context,
      viewer: {
        principal: "nobody",
        principals: [],
        containers: seed.containerIds,
      },
    };
    const denied = parse(
      (await callTool("lookup_object", { id: "PAY-1" }, blind)).content,
    );
    const missing = parse(
      (await callTool("lookup_object", { id: "PAY-1-missing" }, context))
        .content,
    );
    expect(denied.found).toBe(false);
    expect(missing.found).toBe(false);
    expect(Object.keys(denied)).toEqual(Object.keys(missing));
  });

  it("returns direct related evidence with provenance", async () => {
    const payload = parse(
      (await callTool("related_evidence", { id: "PAY-1" }, context)).content,
    ) as unknown as {
      found: boolean;
      evidence: { anchorId: string; relation: string }[];
    };
    expect(payload.found).toBe(true);
    expect(payload.evidence.length).toBeGreaterThan(0);
    expect(
      payload.evidence.every(
        (item) => item.anchorId === "PAY-1" && item.relation.length > 0,
      ),
    ).toBe(true);
  });

  it("does not traverse from a forbidden anchor", async () => {
    const blind: ToolContext = {
      ...context,
      viewer: {
        principal: "nobody",
        principals: [],
        containers: seed.containerIds,
      },
    };
    const payload = parse(
      (await callTool("related_evidence", { id: "PAY-1" }, blind)).content,
    );
    expect(payload).toEqual({
      anchorId: "PAY-1",
      found: false,
      evidence: [],
    });
  });

  it("filters a protected neighbour while preserving visible siblings", async () => {
    const judgment = seed.corpus.relevance.find(
      (item) =>
        item.family === "relationship_navigation" &&
        (item.forbidden?.length ?? 0) > 0,
    );
    expect(judgment).toBeDefined();
    const payload = parse(
      (
        await callTool(
          "related_evidence",
          { id: judgment?.query ?? "" },
          context,
        )
      ).content,
    ) as unknown as { evidence: { id: string }[] };
    const ids = payload.evidence.map((item) => item.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => judgment?.forbidden?.includes(id))).toBe(false);
    expect(audit.entries.at(-1)?.aclRejected).toBeUndefined();
    expect("filteredCount" in payload).toBe(false);
  });

  it("rejects fractional limits outside JSON Schema validation", async () => {
    await expect(
      callTool("related_evidence", { id: "PAY-1", limit: 1.5 }, context),
    ).rejects.toThrow(/limit must be an integer/);
  });
});

describe("search_enterprise", () => {
  it("returns ranked evidence with identifiers and snippets", async () => {
    const result = await callTool(
      "search_enterprise",
      { query: "service ownership incident 1" },
      context,
    );
    const payload = parse(result.content) as unknown as {
      results: { id: string; snippet?: string; syncedAt: string | null }[];
    };
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0]?.id).toBeTruthy();
  });

  it("marks results as untrusted third-party data", async () => {
    // Anyone who can edit a wiki page can write text aimed at an agent reading
    // it. The boundary says so rather than trusting each consumer to remember.
    const result = await callTool(
      "search_enterprise",
      { query: "incident" },
      context,
    );
    expect(parse(result.content).notice).toBe(PROVENANCE_NOTICE);
  });

  it("records one audit entry per read, without recording the results", async () => {
    // The query log is itself sensitive: searching HR or legal terms is a signal
    // worth protecting regardless of what matched.
    await callTool("search_enterprise", { query: "incident" }, context);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      tool: "search_enterprise",
      query: "incident",
    });
    expect(JSON.stringify(audit.entries[0])).not.toContain("PAY-1");
  });

  it("surfaces the ACL counters so drift can be alarmed on", async () => {
    await callTool("search_enterprise", { query: "incident" }, context);
    expect(audit.entries[0]).toMatchObject({ aclRejected: 0, aclDrift: 0 });
  });

  it("rejects a missing or empty query rather than returning everything", async () => {
    await expect(callTool("search_enterprise", {}, context)).rejects.toThrow(
      /query is required/,
    );
    await expect(
      callTool("search_enterprise", { query: "  " }, context),
    ).rejects.toThrow(/query is required/);
  });

  it("clamps limit into range instead of trusting it", async () => {
    const result = await callTool(
      "search_enterprise",
      { query: "incident", limit: 9_999 },
      context,
    );
    expect(
      (parse(result.content) as unknown as { results: unknown[] }).results
        .length,
    ).toBeLessThanOrEqual(50);
  });

  it("honours a source filter", async () => {
    const result = await callTool(
      "search_enterprise",
      { query: "incident", sources: ["jira"] },
      context,
    );
    const payload = parse(result.content) as unknown as {
      results: { source: string }[];
    };
    expect(payload.results.every((hit) => hit.source === "jira")).toBe(true);
  });
});

describe("get_evidence", () => {
  it("returns the content of an authorised document", async () => {
    const payload = parse(
      (await callTool("get_evidence", { id: "PAY-1" }, context)).content,
    ) as unknown as {
      found: boolean;
      body: string;
    };
    expect(payload.found).toBe(true);
    expect(payload.body.length).toBeGreaterThan(0);
  });

  it("re-checks permissions rather than trusting the id — a search result is not a capability", async () => {
    const blind: ToolContext = {
      ...context,
      viewer: {
        principal: "nobody",
        principals: [],
        containers: seed.containerIds,
      },
    };
    const payload = parse(
      (await callTool("get_evidence", { id: "PAY-1" }, blind)).content,
    ) as unknown as {
      found: boolean;
    };
    expect(payload.found).toBe(false);
  });

  it("answers identically for forbidden and non-existent, so existence does not leak", async () => {
    const forbidden: ToolContext = {
      ...context,
      viewer: {
        principal: "nobody",
        principals: [],
        containers: seed.containerIds,
      },
    };
    const denied = parse(
      (await callTool("get_evidence", { id: "PAY-1" }, forbidden)).content,
    );
    const missing = parse(
      (await callTool("get_evidence", { id: "NOPE-999" }, context)).content,
    );
    expect(Object.keys(denied).sort()).toEqual(Object.keys(missing).sort());
    expect(denied.found).toBe(missing.found);
  });

  it("bounds the response", async () => {
    const payload = parse(
      (await callTool("get_evidence", { id: "PAY-1", maxBytes: 200 }, context))
        .content,
    ) as unknown as { body: string };
    expect(payload.body.length).toBeLessThanOrEqual(200);
  });

  it("requires an id", async () => {
    await expect(callTool("get_evidence", {}, context)).rejects.toThrow(
      /id is required/,
    );
  });
});

describe("list_containers and get_freshness", () => {
  it("lists only what the caller can search", async () => {
    const payload = parse(
      (await callTool("list_containers", {}, context)).content,
    ) as unknown as {
      containers: unknown[];
    };
    expect(payload.containers).toHaveLength(seed.containerIds.length);
  });

  it("reports nothing for a caller who can see nothing", async () => {
    const blind: ToolContext = {
      ...context,
      viewer: { principal: "nobody", principals: [], containers: [] },
    };
    const payload = parse(
      (await callTool("list_containers", {}, blind)).content,
    ) as unknown as {
      containers: unknown[];
    };
    expect(payload.containers).toEqual([]);
  });

  it("reports per-source freshness so a consumer can decide whether to trust the index", async () => {
    const payload = parse(
      (await callTool("get_freshness", {}, context)).content,
    ) as unknown as {
      sources: { source: string; publishedResources: number }[];
    };
    expect(payload.sources.length).toBeGreaterThan(0);
    expect(payload.sources.every((entry) => entry.publishedResources > 0)).toBe(
      true,
    );
  });
});

describe("MCP stdio protocol", () => {
  const request = (
    method: string,
    params?: Record<string, unknown>,
    id: number | null = 1,
  ) =>
    handleRequest(
      {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      },
      context,
    );

  it("responds to initialize with the protocol version and tool capability", async () => {
    const response = await request("initialize");
    expect(response?.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
    });
  });

  it("lists the tools with their schemas", async () => {
    const response = await request("tools/list");
    const result = response?.result as {
      tools: { name: string; inputSchema: unknown }[];
    };
    expect(result.tools).toHaveLength(TOOLS.length);
    expect(result.tools[0]?.inputSchema).toBeDefined();
  });

  it("calls a tool and returns text content", async () => {
    const response = await request("tools/call", {
      name: "search_enterprise",
      arguments: { query: "incident" },
    });
    const result = response?.result as {
      content: { type: string; text: string }[];
    };
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "{}").notice).toBe(
      PROVENANCE_NOTICE,
    );
  });

  it("returns a tool failure as isError, not as a transport error", async () => {
    // The model should see what went wrong and try something else, rather than
    // the client concluding the server is broken.
    const response = await request("tools/call", {
      name: "search_enterprise",
      arguments: {},
    });
    const result = response?.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/query is required/);
    expect(response?.error).toBeUndefined();
  });

  it("rejects tools/call without a name", async () => {
    const response = await request("tools/call", {});
    expect(response?.error?.code).toBeDefined();
  });

  it("returns method-not-found for an unknown method", async () => {
    expect((await request("nope"))?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  it("never answers a notification", async () => {
    // A message with no id expects no reply; answering one corrupts the stream.
    expect(
      await handleRequest(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        context,
      ),
    ).toBeNull();
    expect(
      await handleRequest({ jsonrpc: "2.0", method: "nope" }, context),
    ).toBeNull();
  });

  it("answers malformed JSON with a parse error instead of crashing", async () => {
    const response = await handleLine("{not json", context);
    expect(JSON.parse(response ?? "{}").error).toMatchObject({ code: -32700 });
  });

  it("ignores blank lines", async () => {
    expect(await handleLine("   ", context)).toBeNull();
  });

  it("serves a full session over a stream, in order", async () => {
    const written: string[] = [];
    async function* input() {
      yield '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
      yield '{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n';
      // Deliberately split across chunk boundaries: a stdio transport must not
      // assume one write is one message.
      yield '{"jsonrpc":"2.0","id":3,"method":"tools/';
      yield 'call","params":{"name":"get_freshness","arguments":{}}}\n';
    }

    await serveStdio(context, {
      input: input(),
      write: (line) => written.push(line),
    });

    const ids = written.map((line) => JSON.parse(line).id);
    expect(ids).toEqual([1, 2, 3]);
  }, 120_000);
});
