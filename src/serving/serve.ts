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
 *
 * **The tenant, arms and viewer are the same ones `eil search` uses.** They were
 * not, and the consequence was worse than any ranking bug: the server answered
 * every query with an empty result set, because it was reading the evaluation
 * tenant while ingestion wrote to the local one. The CLI found documents and the
 * MCP tool found nothing, from one database, for the same query — and the tool
 * is the surface Amp, Copilot and Claude Code actually connect to.
 */

import { openDatabase } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import { localArms, localViewer, resolveTenant } from "./cli-commands.js";
import { serveStdio } from "./mcp-stdio.js";
import { InMemoryAuditSink, type ToolContext } from "./tools.js";

export async function serveMcp(): Promise<void> {
  const db = await openDatabase({});
  await migrate(db);

  const tenantId = resolveTenant();

  const context: ToolContext = {
    db,
    tenantId,
    arms: localArms(db, tenantId),
    viewer: await localViewer(db, tenantId),
    audit: new InMemoryAuditSink(),
  };

  await serveStdio(context);
  await db.close();
}
