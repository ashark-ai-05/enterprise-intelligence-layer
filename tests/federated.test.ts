import { describe, expect, it } from "vitest";
import {
  FederatedArm,
  type SourceAdapter,
  type SourceResult,
  isLive,
} from "../src/federated/arm.js";
import { retrieve } from "../src/retrieval/pipeline.js";
import {
  type CorpusDocument,
  StrictLexicalArm,
} from "../src/retrieval/stub-arms.js";
import type { Viewer } from "../src/retrieval/types.js";

const VIEWER: Viewer = {
  principal: "user:krunal",
  principals: ["user:krunal"],
  containers: ["ARCH", "PHX"],
};

const sourceResult = (
  id: string,
  source: string,
  container: string,
  title: string,
): SourceResult => ({
  id,
  source,
  container,
  title,
  snippet: `snippet for ${title}`,
  url: `https://example.invalid/${id}`,
  updatedAt: "2026-08-11T00:00:00Z",
});

const adapter = (name: string, results: SourceResult[]): SourceAdapter => ({
  name,
  async search() {
    return results;
  },
});

const failingAdapter = (name: string, message: string): SourceAdapter => ({
  name,
  async search() {
    throw new Error(message);
  },
});

describe("FederatedArm", () => {
  it("fans out to every adapter and flattens the results", async () => {
    const arm = new FederatedArm([
      adapter("confluence", [
        sourceResult("c1", "confluence", "ARCH", "Retry policy"),
      ]),
      adapter("jira", [sourceResult("j1", "jira", "PHX", "PHX-1")]),
    ]);
    const hits = await arm.search({ text: "retry" }, VIEWER);
    expect(hits.map((hit) => hit.id).sort()).toEqual(["c1", "j1"]);
  });

  it("marks results as live, never as synced", async () => {
    // Consumers use this to decide whether they can trust currency, and the
    // pipeline uses it to tell mirroring drift from an arm bug.
    const arm = new FederatedArm([
      adapter("confluence", [sourceResult("c1", "confluence", "ARCH", "x")]),
    ]);
    const [hit] = await arm.search({ text: "x" }, VIEWER);
    expect(hit?.syncedAt).toBeNull();
    expect(isLive(hit!)).toBe(true);
  });

  it("returns partial results when one source fails", async () => {
    // A source outage must degrade the answer, not remove it.
    const arm = new FederatedArm([
      adapter("confluence", [
        sourceResult("c1", "confluence", "ARCH", "Retry policy"),
      ]),
      failingAdapter("jira", "429 rate limited"),
    ]);
    const hits = await arm.search({ text: "retry" }, VIEWER);
    expect(hits.map((hit) => hit.id)).toEqual(["c1"]);
  });

  it("reports itself unavailable when it has no adapters", async () => {
    expect(new FederatedArm([]).isAvailable()).toBe(false);
  });

  it("is named so the query classifier can weight it", () => {
    expect(new FederatedArm([]).name).toBe("federated");
  });
});

describe("federated arm inside the retrieval pipeline", () => {
  const indexed: CorpusDocument[] = [
    {
      id: "c1",
      source: "confluence",
      container: "ARCH",
      title: "Payment retry policy",
      body: "Payments retry three times.",
      url: "https://example.invalid/c1",
      syncedAt: "2026-08-10T00:00:00Z",
    },
  ];

  it("fuses live and indexed results through one pipeline", async () => {
    const result = await retrieve(
      [
        new StrictLexicalArm(indexed),
        new FederatedArm([
          adapter("jira", [
            sourceResult("j9", "jira", "PHX", "Payment retry incident"),
          ]),
        ]),
      ],
      { text: "payment retry" },
      VIEWER,
    );
    expect(result.hits.map((hit) => hit.id).sort()).toEqual(["c1", "j9"]);
    expect(result.armsRun).toContain("federated");
  });

  it("counts a dropped live result as mirroring drift, not as an arm bug", async () => {
    // The source's own search surfaced SEC; our container expansion says the
    // viewer cannot see it. We still fail closed — but this is the signal the
    // two views disagree, which is exactly what the federated arm is for.
    const result = await retrieve(
      [
        new FederatedArm([
          adapter("confluence", [
            sourceResult("s1", "confluence", "SEC", "Restricted"),
          ]),
        ]),
      ],
      { text: "restricted" },
      VIEWER,
    );
    expect(result.hits).toEqual([]);
    expect(result.aclDrift).toBe(1);
    expect(result.aclRejected).toBe(0);
  });

  it("still fails closed on drift — the result is counted, never served", async () => {
    const result = await retrieve(
      [
        new FederatedArm([
          adapter("confluence", [
            sourceResult("s1", "confluence", "SEC", "Restricted"),
          ]),
        ]),
      ],
      { text: "restricted" },
      VIEWER,
    );
    expect(result.hits.some((hit) => hit.container === "SEC")).toBe(false);
  });

  it("keeps arm-bug rejections separate from drift", async () => {
    // An indexed arm returning an out-of-scope container is a bug in that arm,
    // and must not be filed under "the source disagrees with us".
    const leaky: CorpusDocument[] = [
      {
        id: "x1",
        source: "confluence",
        container: "SEC",
        title: "Restricted",
        body: "restricted",
        url: "u",
        syncedAt: "2026-08-10T00:00:00Z",
      },
    ];
    class IgnoresScope extends StrictLexicalArm {
      override async search() {
        const { body: _body, ...hit } = leaky[0] as CorpusDocument;
        return [hit];
      }
    }
    const result = await retrieve(
      [new IgnoresScope(leaky)],
      { text: "restricted" },
      VIEWER,
    );
    expect(result.aclRejected).toBe(1);
    expect(result.aclDrift).toBe(0);
  });

  it("degrades to indexed results when every federated source is down", async () => {
    const result = await retrieve(
      [
        new StrictLexicalArm(indexed),
        new FederatedArm([failingAdapter("jira", "connection refused")]),
      ],
      { text: "payment retry" },
      VIEWER,
    );
    expect(result.hits.map((hit) => hit.id)).toEqual(["c1"]);
  });
});
