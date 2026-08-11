/**
 * `eil serve` — MCP over stdio, personal mode.
 *
 * Each user runs their own process against their own database, so the OS user
 * is a sound identity and no OIDC is involved. That is exactly why this is the
 * distribution mechanism that needs no approvals.
 *
 * The platform-mode equivalent must derive the viewer from verified token
 * claims per request. The local viewer below must not survive into it: a shared
 * server using it would give every caller the server's own access.
 */

import { EVAL_TENANT, defaultArms, evalViewer } from "../eval/corpus-gate.js";
import { openDatabase } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import { serveStdio } from "./mcp-stdio.js";
import { InMemoryAuditSink, type ToolContext } from "./tools.js";

export async function serveMcp(): Promise<void> {
  const db = await openDatabase({});
  await migrate(db);

  const containers = await db.query<{ id: string }>(
    "SELECT id FROM containers WHERE tenant_id = $1",
    [EVAL_TENANT],
  );

  const context: ToolContext = {
    db,
    tenantId: EVAL_TENANT,
    arms: defaultArms(db),
    viewer: evalViewer(containers.rows.map((row) => row.id)),
    audit: new InMemoryAuditSink(),
  };

  await serveStdio(context);
  await db.close();
}
