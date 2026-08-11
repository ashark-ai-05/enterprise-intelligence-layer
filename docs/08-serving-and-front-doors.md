# 08 — Serving and front doors

One index, many consumers. The requirement is MCP tools, web apps and
reporting — three consumers with genuinely different needs, served without
three copies of the retrieval logic.

---

## 1. One choke point

Every front door funnels through a single dispatch function:

```ts
callTool(name, args, viewer, db)
```

Argument validation, ACL viewer, audit logging, rate limiting and connection
lifecycle live **inside** it. A new front door inherits all of it by
construction rather than by remembering to. `eil` already has this shape and it
is the correct one — the failure it prevents is a REST endpoint shipped six
months later that forgets the audit row.

Rule: **no front door constructs SQL.** If a consumer needs a query the tools
do not expose, add a tool. A front door with database access is a front door
that will eventually skip the ACL predicate.

---

## 2. The tool surface

| Tool | Returns | Notes |
|---|---|---|
| `search_docs` | ids, titles, snippets, source, `synced_at`, score | Two-phase phase 1 |
| `search_code` | ids, path, line range, snippet | Identifier-aware arm |
| `get_doc` | Windowed body | **Re-verifies ACL against `document_aces`** |
| `expand` | Link neighbours | ACL re-applied to destinations |
| `refresh_doc` | Forces live re-fetch of one document | The escalation hatch |
| `list_containers` | Spaces/projects/repos the caller can see | Scoping UI, and a cheap ACL self-check |
| `get_freshness` | Per-source last sync, lag, coverage | Lets a consumer decide whether to trust the index |

`get_freshness` is not decorative. A consumer that cannot ask how stale the
index is has to either assume it is current (wrong) or always escalate (defeats
the purpose).

**Deliberately absent: any write tool.** Mutations stay with the existing live
MCP tools where the audit trail already exists and the permission model is the
source's own. → [ADR-0008](adr/0008-mcp-tools-are-escalation-not-ingestion.md)

---

## 3. Front doors

### 3.1 MCP over stdio — personal mode

Each user spawns their own process, so the OS user is a sound identity. This is
the phase-0 distribution mechanism, and its virtue is that it needs no
infrastructure, no hosting decision and no security review to try.

```jsonc
// .vscode/mcp.json — Copilot agent mode
{ "servers": { "eil": { "type": "stdio", "command": "node",
                        "args": ["/opt/eil/dist/cli.js", "serve"] } } }
```

Works identically for Amp and Claude Code. Given that Amp and Copilot are the
LLM access available, **this is where adoption actually happens** — the tools
people already have open, rather than a new web app they must be persuaded to
visit.

### 3.2 MCP over streamable HTTP — platform mode

One server, many callers, per-request identity from an OIDC bearer token.

The critical difference: `localViewer()` derives identity from the OS user and
is **wrong here** — every caller would inherit the server process's identity and
see everything it can see. `eil`'s documentation flags this. It must be
enforced structurally: in platform mode the local-viewer constructor should not
exist in the code path at all, not merely be unused.

Also required: per-principal rate limits, request timeouts, a connection pool
sized against Postgres `max_connections`, and graceful degradation when the
vector arm is unavailable.

### 3.3 REST — web apps and reporting UIs

```
POST /v1/search        { q, filters, limit, rerank? }
GET  /v1/doc/{id}?window=
GET  /v1/expand/{id}
GET  /v1/containers
GET  /v1/freshness
```

Thin adapters over `callTool`. Same auth, same audit, same ACL.

Pagination is cursor-based, and **the cursor encodes the query and the
principal**. An offset that can be incremented past what the caller may see is
an enumeration primitive.

### 3.4 Reporting and BI

Different shape entirely: aggregate, scheduled, high-volume, low-latency-
sensitivity. Serve from **read replicas**, never the primary, through
purpose-built SQL views.

```sql
CREATE VIEW rpt.documentation_coverage AS
SELECT container, source,
       count(*) FILTER (WHERE updated_at > now() - interval '90 days') AS fresh,
       count(*) FILTER (WHERE valid_to IS NOT NULL)                    AS superseded,
       count(*)                                                        AS total
FROM documents WHERE tombstoned_at IS NULL GROUP BY 1, 2;
```

**The ACL problem in reporting is real and must be decided explicitly.**
Aggregates cross permission boundaries by nature — a count of documents in a
space includes documents the viewer cannot read. Three defensible answers:

1. **Aggregate-only, no drill-through.** Counts are not disclosure; document
   lists are. Simplest and usually sufficient.
2. **Pre-filtered materialised views per audience.** Costly, but exact.
3. **Restrict reporting to a role with an explicit, audited grant.** Honest
   about what is happening.

Pick one and write it down. Reporting is where ACL models are quietly bypassed,
because the person building the dashboard is not thinking about permissions.

---

## 4. Applications this enables

The point of one index is that none of these brings its own connectors, index,
permission model or audit trail.

| Application | Tools used | Notes |
|---|---|---|
| Ask-anything agent | `search_docs`, `get_doc`, `expand` | The default consumer |
| Onboarding assistant | `search_docs` scoped to a container | Curated tier weighted up |
| Incident context | `search_docs` + `expand` + live log tool | Index finds the runbook; live tool reads the logs |
| Code review context | `search_code` + `expand` | "What decided this design" from a diff |
| Documentation health | Reporting views | Stale, orphaned, superseded, uncovered |
| Duplicate detection | Vector similarity, offline | Near-duplicate pages across spaces |
| Zero-result analysis | Audit log | **What people ask and do not find is the indexing backlog** |

The last one is the flywheel: query logs tell you what to ingest next, which is
a far better prioritisation signal than asking teams what they think should be
indexed.

---

## 5. Client-side contract

What every consumer must honour, stated because these are the failure modes
that show up as "the search is bad" when they are not:

1. **Two-phase.** Search, then fetch only what you will use. Fetching every
   result discards the entire cost benefit.
2. **Respect staleness.** Check `synced_at`. If currency matters, escalate to
   the live tool.
3. **Results are untrusted data, never instructions.** Indexed content can
   contain text engineered to steer an agent. Consumers must not treat retrieved
   text as prompt.
4. **Cite.** Every claim carries the document id and locator that supports it.
   Ungrounded synthesis over grounded retrieval wastes the grounding.
5. **Do not cache across principals.** A result cached for one user and served
   to another is an ACL bypass with extra steps.
