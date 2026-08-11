import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimJob,
  completeJob,
  enqueueJob,
  extendJobLease,
  failJob,
  saveJobCheckpoint,
} from "../src/jobs/queue.js";
import {
  getQueueStatus,
  listDeadLetters,
  replayDeadLetter,
  setScopeEnabled,
} from "../src/operator/control.js";
import { createScope, getScope } from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

let db: Database;

beforeEach(async () => {
  db = await testDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("durable job queue", () => {
  it("deduplicates enqueue by tenant and idempotency key", async () => {
    const first = await enqueueJob(db, {
      tenantId: "acme",
      jobType: "scope.sync",
      payload: { scopeId: "one" },
      idempotencyKey: "scope:one:window:1",
    });
    const duplicate = await enqueueJob(db, {
      tenantId: "acme",
      jobType: "scope.sync",
      payload: { scopeId: "changed" },
      idempotencyKey: "scope:one:window:1",
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.payload).toEqual({ scopeId: "one" });
    expect(
      (
        await enqueueJob(db, {
          tenantId: "other",
          jobType: "scope.sync",
          payload: {},
          idempotencyKey: "scope:one:window:1",
        })
      ).id,
    ).not.toBe(first.id);
  });

  it("prioritizes live work, checkpoints, extends, and completes under one fence", async () => {
    await enqueueJob(db, {
      tenantId: "acme",
      jobType: "backfill",
      lane: "backfill",
      payload: {},
      idempotencyKey: "backfill:1",
    });
    await enqueueJob(db, {
      tenantId: "acme",
      jobType: "delta",
      lane: "live",
      payload: {},
      idempotencyKey: "delta:1",
    });
    const claimed = await claimJob(db, "acme", "worker-1", 60);
    expect(claimed?.jobType).toBe("delta");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.fenceToken).toBe(1);
    if (!claimed) throw new Error("expected a claimed job");
    const checkpointed = await saveJobCheckpoint(db, claimed, { page: 7 });
    expect(checkpointed.checkpoint).toEqual({ page: 7 });
    const extended = await extendJobLease(db, checkpointed, 120);
    expect(extended.leaseExpiresAt?.getTime()).toBeGreaterThan(
      checkpointed.leaseExpiresAt?.getTime() ?? 0,
    );
    expect((await completeJob(db, extended)).status).toBe("completed");
  });

  it("rejects stale workers after an expired lease is reclaimed", async () => {
    await enqueueJob(db, {
      tenantId: "acme",
      jobType: "delta",
      payload: {},
      idempotencyKey: "delta:stale",
    });
    const stale = await claimJob(db, "acme", "worker-old", 60);
    if (!stale) throw new Error("expected a claimed job");
    await db.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [stale.id],
    );
    const current = await claimJob(db, "acme", "worker-new", 60);
    expect(current?.fenceToken).toBe(stale.fenceToken + 1);
    await expect(completeJob(db, stale)).rejects.toThrow(
      "stale or expired job lease",
    );
    if (!current) throw new Error("expected a reclaimed job");
    await expect(completeJob(db, current)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("retries with its checkpoint and dead-letters at max attempts", async () => {
    await enqueueJob(db, {
      tenantId: "acme",
      jobType: "delta",
      payload: {},
      idempotencyKey: "delta:poison",
      maxAttempts: 2,
    });
    const first = await claimJob(db, "acme", "worker", 60);
    if (!first) throw new Error("expected first attempt");
    const checkpointed = await saveJobCheckpoint(db, first, { cursor: "p2" });
    expect((await failJob(db, checkpointed, "temporary", 0)).status).toBe(
      "pending",
    );
    const second = await claimJob(db, "acme", "worker", 60);
    expect(second?.checkpoint).toEqual({ cursor: "p2" });
    if (!second) throw new Error("expected second attempt");
    expect((await failJob(db, second, "poison", 0)).status).toBe("dead_letter");
    expect(await listDeadLetters(db, "acme")).toEqual([
      {
        id: second.id,
        jobType: "delta",
        attempts: 2,
        lastError: "poison",
      },
    ]);
  });

  it("does not claim future work or another tenant's work", async () => {
    await enqueueJob(db, {
      tenantId: "acme",
      jobType: "future",
      payload: {},
      idempotencyKey: "future",
      runAfter: "2099-01-01T00:00:00Z",
    });
    await enqueueJob(db, {
      tenantId: "other",
      jobType: "due",
      payload: {},
      idempotencyKey: "due",
    });
    expect(await claimJob(db, "acme", "worker", 60)).toBeNull();
  });

  it("rejects a scope from another tenant", async () => {
    const scope = await createScope(db, {
      tenantId: "other",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      addedBy: "operator",
    });
    await expect(
      enqueueJob(db, {
        tenantId: "acme",
        scopeId: scope.id,
        jobType: "scope.sync",
        payload: {},
        idempotencyKey: "wrong-tenant",
      }),
    ).rejects.toThrow("job scope must belong to the same tenant");
  });
});

describe("operator controls", () => {
  it("reports queue health and audits dead-letter replay", async () => {
    await enqueueJob(db, {
      tenantId: "acme",
      jobType: "delta",
      payload: {},
      idempotencyKey: "replay-me",
      maxAttempts: 1,
    });
    const claimed = await claimJob(db, "acme", "worker", 60);
    if (!claimed) throw new Error("expected a claimed job");
    const checkpointed = await saveJobCheckpoint(db, claimed, { page: 4 });
    await failJob(db, checkpointed, "failed", 0);
    expect(await getQueueStatus(db, "acme")).toMatchObject({
      counts: { pending: 0, claimed: 0, completed: 0, dead_letter: 1 },
      duePending: 0,
      expiredLeases: 0,
    });
    await replayDeadLetter(db, "acme", claimed.id, "operator", true);
    const replayed = await claimJob(db, "acme", "worker-2", 60);
    expect(replayed).toMatchObject({ attempts: 1, checkpoint: null });
    const audit = await db.query<{ action: string; actor: string }>(
      "SELECT action, actor FROM operator_events",
    );
    expect(audit.rows).toEqual([{ action: "job.replay", actor: "operator" }]);
  });

  it("pauses and resumes a tenant-bound scope with an audit trail", async () => {
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      addedBy: "operator",
    });
    await enqueueJob(db, {
      tenantId: "acme",
      scopeId: scope.id,
      jobType: "scope.sync",
      payload: {},
      idempotencyKey: "scope:PAY:1",
    });
    await setScopeEnabled(db, "acme", scope.id, false, "operator");
    expect((await getScope(db, "acme", scope.id)).enabled).toBe(false);
    expect(await claimJob(db, "acme", "worker", 60)).toBeNull();
    await expect(
      setScopeEnabled(db, "other", scope.id, true, "intruder"),
    ).rejects.toThrow(`unknown scope: ${scope.id}`);
    await setScopeEnabled(db, "acme", scope.id, true, "operator");
    expect((await getScope(db, "acme", scope.id)).enabled).toBe(true);
    expect(await claimJob(db, "acme", "worker", 60)).toMatchObject({
      scopeId: scope.id,
    });
    const events = await db.query<{ action: string }>(
      "SELECT action FROM operator_events ORDER BY created_at, id",
    );
    expect(events.rows.map(({ action }) => action)).toEqual([
      "scope.pause",
      "scope.resume",
    ]);
  });
});
