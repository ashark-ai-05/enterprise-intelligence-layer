import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import {
  acquireSourceRatePermit,
  configureSourceRateBudget,
  scheduleDueScopes,
  scheduleSeconds,
} from "../src/jobs/scheduler.js";
import {
  StaticConnectorRegistry,
  runNextScopeJob,
} from "../src/jobs/scope-worker.js";
import { createScope } from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

let db: Database;
beforeEach(async () => {
  db = await testDatabase();
});
afterEach(async () => {
  await db.close();
});

describe("scope scheduler and source rate budgets", () => {
  it("parses bounded interval schedules", () => {
    expect(scheduleSeconds("30 minutes")).toBe(1_800);
    expect(scheduleSeconds("1 day")).toBe(86_400);
    expect(() => scheduleSeconds("* * * * *")).toThrow("unsupported schedule");
  });

  it("enqueues only due automatic scopes and advances their due time", async () => {
    const scheduled = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["ENG"] },
      refreshMode: "scheduled",
      schedule: "30 minutes",
      addedBy: "operator",
    });
    await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      refreshMode: "manual",
      addedBy: "operator",
    });
    const now = new Date("2026-08-11T10:00:00Z");
    const first = await scheduleDueScopes(db, "acme", now);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      scopeId: scheduled.id,
      nextRunAt: new Date("2026-08-11T10:30:00Z"),
    });
    expect(
      await scheduleDueScopes(db, "acme", new Date("2026-08-11T10:29:59Z")),
    ).toEqual([]);
    expect(
      await scheduleDueScopes(db, "acme", new Date("2026-08-11T10:30:00Z")),
    ).toHaveLength(1);
  });

  it("refills a tenant/source token bucket deterministically", async () => {
    const now = new Date("2026-08-11T10:00:00Z");
    await configureSourceRateBudget(
      db,
      {
        tenantId: "acme",
        source: "confluence",
        capacity: 1,
        refillPerSecond: 0.5,
      },
      now,
    );
    expect(
      await acquireSourceRatePermit(db, "acme", "confluence", now),
    ).toEqual({ allowed: true, retryAt: null });
    expect(
      await acquireSourceRatePermit(db, "acme", "confluence", now),
    ).toEqual({ allowed: false, retryAt: new Date("2026-08-11T10:00:02Z") });
    expect(
      await acquireSourceRatePermit(
        db,
        "acme",
        "confluence",
        new Date("2026-08-11T10:00:02Z"),
      ),
    ).toEqual({ allowed: true, retryAt: null });
    expect(
      await acquireSourceRatePermit(db, "other", "confluence", now),
    ).toEqual({ allowed: true, retryAt: null });
  });

  it("defers a rate-limited scope job without consuming an attempt", async () => {
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["ENG"] },
      refreshMode: "continuous",
      addedBy: "operator",
    });
    const now = new Date();
    await configureSourceRateBudget(
      db,
      {
        tenantId: "acme",
        source: "confluence",
        capacity: 1,
        refillPerSecond: 0.01,
      },
      now,
    );
    await acquireSourceRatePermit(db, "acme", "confluence", now);
    await scheduleDueScopes(db, "acme", now);
    const result = await runNextScopeJob(
      db,
      "acme",
      "worker",
      new StaticConnectorRegistry(
        new Map([["confluence", new StubConfluenceConnector([])]]),
      ),
    );
    expect(result).toMatchObject({ status: "pending" });
    const job = await db.query<{ attempts: number; status: string }>(
      "SELECT attempts, status FROM jobs WHERE scope_id = $1",
      [scope.id],
    );
    expect(job.rows[0]).toMatchObject({ attempts: 0, status: "pending" });
  });
});
