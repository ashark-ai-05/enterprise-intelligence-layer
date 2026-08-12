import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FixtureConnectorRegistry,
  LiveConnectorRegistry,
  SELECTORS,
  addScopeCommand,
  buildSelector,
  ingestCommand,
  listScopesCommand,
  removeScopeCommand,
  resolveTenant,
  searchCommand,
} from "../src/serving/cli-commands.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

const TENANT = "local";
let db: Database;

beforeEach(async () => {
  db = await testDatabase();
}, 120_000);

afterEach(async () => {
  await db.close();
});

describe("resolveTenant", () => {
  it("defaults to local and is overridable", () => {
    expect(resolveTenant({} as NodeJS.ProcessEnv)).toBe("local");
    expect(resolveTenant({ EIL_TENANT: "acme" } as NodeJS.ProcessEnv)).toBe(
      "acme",
    );
  });
});

describe("buildSelector", () => {
  it("maps each kind onto the selector shape ingestion expects", () => {
    expect(buildSelector("space", ["ARCH", "ENG"])).toEqual({
      keys: ["ARCH", "ENG"],
    });
    expect(buildSelector("project", ["PAY"])).toEqual({ keys: ["PAY"] });
    expect(buildSelector("page", ["12345"])).toEqual({ ids: ["12345"] });
    expect(buildSelector("issues", ["PAY-1"])).toEqual({ ids: ["PAY-1"] });
    expect(buildSelector("repositories", ["svc"])).toEqual({
      repositories: ["svc"],
      refs: ["main"],
    });
  });

  it("rejects an unknown kind rather than guessing a shape", () => {
    expect(() => buildSelector("nonsense", ["x"])).toThrow(
      /unknown selector kind/,
    );
  });
});

describe("scope commands", () => {
  it("adds a Confluence space scope", async () => {
    const scope = await addScopeCommand(db, TENANT, {
      source: "confluence",
      kind: "space",
      values: ["ARCH"],
      addedBy: "test",
    });
    expect(scope.source).toBe("confluence");
    expect(scope.selector).toEqual({ keys: ["ARCH"] });
    expect(scope.refreshMode).toBe("manual");
  });

  it("adds a scheduled scope when an interval is given", async () => {
    const scope = await addScopeCommand(db, TENANT, {
      source: "jira",
      kind: "project",
      values: ["PAY"],
      schedule: "1h",
      addedBy: "test",
    });
    expect(scope.refreshMode).toBe("scheduled");
    expect(scope.schedule).toBe("1h");
  });

  it("rejects a selector the source cannot honour, naming what it accepts", async () => {
    await expect(
      addScopeCommand(db, TENANT, {
        source: "jira",
        kind: "space",
        values: ["ARCH"],
        addedBy: "test",
      }),
    ).rejects.toThrow(/jira accepts: project, issues/);
  });

  it("requires at least one selector value", async () => {
    await expect(
      addScopeCommand(db, TENANT, {
        source: "confluence",
        kind: "space",
        values: [],
        addedBy: "test",
      }),
    ).rejects.toThrow(/at least one selector value/);
  });

  it("lists and removes scopes", async () => {
    const scope = await addScopeCommand(db, TENANT, {
      source: "bitbucket",
      kind: "repositories",
      values: ["payments-api"],
      addedBy: "test",
    });
    expect(await listScopesCommand(db, TENANT)).toHaveLength(1);
    await removeScopeCommand(db, TENANT, scope.id, false);
    expect(await listScopesCommand(db, TENANT)).toHaveLength(0);
  });

  it("documents a selector vocabulary for every source", () => {
    for (const kinds of Object.values(SELECTORS))
      expect(kinds.length).toBeGreaterThan(0);
  });
});

describe("ingest refuses rather than substitutes", () => {
  it("errors clearly when no live connector exists, instead of ingesting fixtures", async () => {
    // Ingesting synthetic pages under the name of a real space would look like
    // success and only surface when search returned documents that do not
    // exist. An error is the kinder failure.
    const scope = await addScopeCommand(db, TENANT, {
      source: "bitbucket",
      kind: "repositories",
      values: ["payments-api"],
      addedBy: "test",
    });

    const outcomes = await ingestCommand(
      db,
      TENANT,
      [scope],
      new LiveConnectorRegistry(),
    );
    expect(outcomes[0]?.status).not.toBe("completed");
    expect(outcomes[0]?.error).toMatch(
      /No live bitbucket connector is implemented yet/,
    );
  }, 120_000);

  it("names the fixture path in the error, so the message is actionable", async () => {
    const scope = await addScopeCommand(db, TENANT, {
      source: "bitbucket",
      kind: "repositories",
      values: ["payments-api"],
      addedBy: "test",
    });
    const outcomes = await ingestCommand(
      db,
      TENANT,
      [scope],
      new LiveConnectorRegistry(),
    );
    expect(outcomes[0]?.error).toMatch(/pnpm demo/);
    expect(outcomes[0]?.error).toMatch(/--fixture/);
  }, 120_000);

  it("runs through the durable queue when fixtures are requested explicitly", async () => {
    const scope = await addScopeCommand(db, TENANT, {
      source: "confluence",
      kind: "space",
      values: ["ARCH"],
      addedBy: "test",
    });
    const outcomes = await ingestCommand(
      db,
      TENANT,
      [scope],
      new FixtureConnectorRegistry(),
    );
    expect(outcomes[0]?.status).toBe("completed");
  }, 120_000);
});

describe("search", () => {
  it("returns nothing before anything is ingested, rather than failing", async () => {
    const result = await searchCommand(db, TENANT, "payment retry");
    expect(result.hits).toEqual([]);
  }, 120_000);
});

describe("argument parsing", () => {
  // Found by running the built binary, not by a test: `--schedule 1h` put "1h"
  // into the selector, creating a scope for a Jira project literally named 1h.
  // Silent, and only visible in `scope list`.
  function positionalArgs(args: readonly string[]): string[] {
    const positional: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index] as string;
      if (value.startsWith("--")) {
        index += 1;
        continue;
      }
      positional.push(value);
    }
    return positional;
  }

  it("excludes a flag and its value from positional arguments", () => {
    expect(
      positionalArgs(["jira", "project", "PAY", "--schedule", "1h"]),
    ).toEqual(["jira", "project", "PAY"]);
  });

  it("keeps positional arguments that follow a valueless trailing flag", () => {
    expect(positionalArgs(["confluence", "space", "ARCH", "ENG"])).toEqual([
      "confluence",
      "space",
      "ARCH",
      "ENG",
    ]);
  });
});
