# 16 — Scoped ingestion and storage profiles

Two changes requested, both with consequences larger than they look:

1. **Ingestion is explicitly scoped** — you name the Confluence spaces or pages,
   the Jira projects or filters, and the repositories or subtrees. Not
   crawl-everything-and-poll.
2. **Storage is configurable** — an embedded local Postgres today, a hosted
   Postgres later, same schema, same SQL.

The first one is not a convenience feature. **It changes the capacity story by
two orders of magnitude, and in doing so it deletes the single most complex and
error-prone workstream in the design.** That is worth more than any optimisation
anyone has proposed in this thread.

---

## 1. Scopes

### 1.1 The model

A **scope** is a durable, human-readable statement: *"this set of source
material is part of my corpus."* It is the unit of configuration, the unit of
sync, the unit of removal, and the unit of audit.

```sql
CREATE TABLE scopes (
  id             text PRIMARY KEY,       -- 'confluence:space:ARCH'
  source         text NOT NULL,          -- confluence | jira | bitbucket | files
  selector_kind  text NOT NULL,          -- space | page | label | cql | project
                                         -- | issue | jql | repo | path
  selector       text NOT NULL,          -- 'ARCH' | '12345' | 'project = PHX AND …'
  recursive      boolean NOT NULL DEFAULT true,   -- descendants / all repos in project
  trigger        text NOT NULL DEFAULT 'manual',  -- manual | scheduled | on-reference
  schedule       text,                   -- interval, NULL when manual
  enabled        boolean NOT NULL DEFAULT true,
  added_by       text NOT NULL,
  added_at       timestamptz NOT NULL,
  cursor         jsonb,                  -- per-scope, NOT per-source
  last_sync_at   timestamptz,
  last_status    text,
  doc_count      int
);

-- A document can belong to more than one scope. This table is why removal works.
CREATE TABLE document_scopes (
  document_id  bigint REFERENCES documents(id) ON DELETE CASCADE,
  scope_id     text   REFERENCES scopes(id)    ON DELETE CASCADE,
  PRIMARY KEY (document_id, scope_id)
);
```

The cursor moving from source-level to **scope-level** is the key schema change.
Each scope syncs on its own clock, at its own cadence, with its own cursor and
its own failure state. A rate-limited Confluence space does not stall a Jira
project.

### 1.2 Selectors

| Source | Selector kinds | Example |
|---|---|---|
| Confluence | `space` · `page` (+`recursive`) · `label` · `cql` | `confluence:space:ARCH`, `confluence:page:81923+desc`, `confluence:label:runbook` |
| Jira | `project` · `issue` · `filter` · `jql` | `jira:project:PHX`, `jira:jql:project = PHX AND labels = design` |
| Bitbucket | `repo@ref` · `project` · `repo@ref:subtree` | `bitbucket:repo:PLAT/phx-ledger@main`, `bitbucket:repo:PLAT/monorepo@main:services/payments/**` |
| Files | `path` glob | `files:path:/Users/you/Documents/notes/**` |

`jql` and `cql` are the general case — filters, boards and sprints all reduce to
a JQL string, so one selector kind covers them rather than four.

**The monorepo subtree selector matters more than it looks.** "Massive
codebases" was in the original brief; scoping to
`services/payments/**` turns a 20M-line monorepo into a 200k-line corpus without
giving up anything you would actually search. Indexing a whole monorepo to
answer questions about one service is a cost with no matching benefit.

### 1.3 Triggers

| Trigger | Behaviour | Use |
|---|---|---|
| `manual` | Syncs when you say so — CLI or MCP tool | Default. An archive space you read occasionally |
| `scheduled` | Per-scope interval | The project you work in. Hourly is generous |
| `on-reference` | Auto-queued when retrieval surfaces a link into it | Lazy expansion — see §1.5 |

**Delta does not go away, it gets cheaper.** A subscribed scope still changes:
pages get edited, issues get commented, branches move. The three-hash gate,
cursors, tombstones and reconciliation all still apply — but to a chosen set
rather than to everything. The change is *what* is synced, not *whether* deltas
are computed.

```
eil scope add confluence:space:ARCH --schedule 1h
eil scope add jira:jql "project = PHX AND updated >= -90d"
eil scope add bitbucket:repo:PLAT/monorepo@main:services/payments/**
eil scope list
eil sync --scope confluence:space:ARCH
eil sync --all
eil scope remove confluence:space:OLD --purge
```

### 1.4 Removal, and the bug it is easy to ship

A page can belong to two scopes at once — inside `space:ARCH` **and** added
individually as `page:81923`. Delete the space scope and the naive
implementation deletes the page, silently, out from under the scope that still
wants it.

**`document_scopes` is refcounting.** Removal is:

```sql
DELETE FROM document_scopes WHERE scope_id = $1;
DELETE FROM documents d
 WHERE NOT EXISTS (SELECT 1 FROM document_scopes ds WHERE ds.document_id = d.id);
```

Two behaviours worth making explicit rather than discovering:

- **`scope remove` without `--purge` leaves the documents**, marked orphaned and
  no longer synced. Removing a subscription and destroying data are different
  intentions, and conflating them makes the destructive one the default.
- **Overlapping scopes never double-ingest.** Identity is the canonical document
  id, not the scope that found it. A page reached through two scopes is one row
  with two `document_scopes` entries.

### 1.5 The boundary: references out of scope

The link graph will point at things you did not index — a design doc citing
`PHX-4471`, a runbook linking a page in a space you never added. Two choices,
and the interesting one wins.

**Store a stub**: canonical id, title, URL, `out_of_scope = true`, no body, no
chunks, no vectors.

- *"This design references PHX-4471, which isn't in your corpus"* is a genuinely
  useful answer, and strictly better than the reference vanishing.
- The stub table **is** the `on-reference` queue. Anything repeatedly hit
  becomes an obvious candidate: `SELECT … ORDER BY reference_count DESC` is your
  scope backlog, derived from actual demand rather than a guess.

One caveat to carry forward: **a stub carries a title, and a title is
ACL-bearing.** In personal mode this is safe — you saw the link on a page you
can read. In platform mode a stub needs its own ACE, or it leaks the existence
and name of something the viewer cannot see. Flagged in
[05](05-acl-and-security.md)'s terms, not solved here.

### 1.6 Scopes are the governance answer

A side effect worth stating plainly: `scopes` is a short, human-readable,
exportable list of exactly what the system has copied and why.

That is the artefact a works council, a privacy reviewer or a Confluence admin
asks for. "We index the whole instance and filter on read" is a much harder
conversation than "we index these six spaces, here is the list, here is who
added each and when." → D4 in [15](15-open-questions-and-delivery-plan.md).

### 1.7 What scopes simplify in the ACL model

In **personal mode**, adding a scope is an assertion: *I can read this, index
it.* Container ACEs seed from the ingesting principal, and the elaborate
authority machinery is not needed to be correct.

It is still needed for **platform mode**, and nothing in
[05](05-acl-and-security.md) or the identity plane in
[15](15-open-questions-and-delivery-plan.md) is deleted. It is **phase-gated**:
P1 ships scope-seeded ACLs, and the full principal map arrives with the first
shared index. That moves ~2 weeks of the hardest work out of the critical path
without moving it off the roadmap.

---

## 2. What this does to capacity — the part that matters

| | Whole-instance crawl | Scoped |
|---|---|---|
| Documents | ~2,000,000 | ~20,000–80,000 |
| Chunks | ~20,000,000 | ~200,000–800,000 |
| Vector bytes @384 dims | ~30 GB | **~300 MB – 1.2 GB** |
| Vector search | IVF lists + binary signatures + `nprobe` calibration + mandatory exact rescore | **Exact brute-force scan** |
| Backfill | ~28 hours/worker | **~10–60 minutes** |
| Postgres | Provisioned server + replicas | **Embedded is genuinely sufficient** |

### 2.1 The workstream this deletes

Below roughly **1M chunks, an exact vector scan is the correct implementation.**
A sequential scan over 800k × 384 float4 is a few hundred MB of memory
bandwidth — tens of milliseconds, and it is *exact*, so:

- no IVF centroid training,
- no `nprobe` calibration,
- no binary quantisation and its measured 63.5% recall@10,
- no two-stage rescore,
- **no silent recall drift as the corpus grows** — the failure mode nobody
  detects until someone notices results got quietly worse.

That is P3-4 in [15](15-open-questions-and-delivery-plan.md), the largest single
task in the vector workstream, reduced from a calibrated approximate-search
subsystem to a `SELECT … ORDER BY distance LIMIT k` with a container pre-filter
in front of it.

**Keep the funnel design in the docs** for the day a scope set grows past ~1M
chunks — it is written and costs nothing to leave written. Do not build it now.
Ship the exact scan, measure, and add the funnel when a measurement demands it.

The general point: **scoping is a better performance decision than any
indexing technique in this design.** Not indexing something is faster than
indexing it cleverly.

---

## 3. Storage profiles

### 3.1 Two profiles, one schema

| | `embedded` | `server` |
|---|---|---|
| Engine | PGlite (WASM Postgres) | PostgreSQL 16 + read replicas |
| Persistence | Local filesystem directory | Managed volume, backups |
| Connections | **One.** Single-user mode | Pool |
| Workers | **In-process loop, concurrency 1** | N worker processes |
| Extensions | `pgvector` via [`@electric-sql/pglite-pgvector`](https://pglite.dev/extensions/) | Whatever the DBA approves |
| Ceiling | ~1M chunks comfortably | The design's full capacity model |
| Approvals | None | Provisioning, backup, security review |

`DATABASE_URL` absent → `embedded`, at `EIL_DATA_DIR`. Present → `server`.
One environment variable is the whole switch.

### 3.2 The constraint that shapes the code

PGlite is **single-user, single-connection by design** — Emscripten cannot fork,
so Postgres is compiled in single-user mode
([PGlite docs](https://pglite.dev/), [electric-sql/pglite](https://github.com/electric-sql/pglite)).
v0.4 added connection *multiplexing* over that one connection, which helps
callers but does not create a second process.

Two concrete implications, both cheap if designed in and painful if discovered:

1. **The job queue must be correct at concurrency 1.** `FOR UPDATE SKIP LOCKED`
   with fenced leases already is — it degrades to a plain work loop with one
   worker. Nothing changes. This is a small vindication of not choosing a broker.
2. **Never assume a second connection is available.** Any code path that holds a
   transaction open and asks the pool for another connection deadlocks under
   `embedded` and works fine under `server` — the worst kind of bug, invisible in
   the profile most people develop against. One rule: **a request or job uses
   exactly one connection for its lifetime.** Enforce it in the data-access
   layer, not by discipline.

### 3.3 Capability detection, not configuration

Which extensions exist is **detected at boot and stored**, never assumed or
configured:

```sql
CREATE TABLE capabilities (name text PRIMARY KEY, available boolean, detected_at timestamptz);
-- probed: vector, pg_trgm, pg_search, unaccent
```

Retrieval selects arms from `capabilities`. A missing extension disables an arm;
it never produces an error and never silently returns wrong results.

There is a pleasing inversion here worth noting: **`pgvector` may be more
available under `embedded` than under `server`.** It installs from npm for
PGlite; on a corporate hosted Postgres it needs a DBA to approve it. The
extension-free `float4[]` path in
[ADR-0002](adr/0002-one-postgres-no-mandatory-extensions.md) remains the right
default precisely because neither profile can be relied on.

### 3.4 Migration between profiles must be a command, not a hope

Because the schema and every SQL statement are identical, moving embedded →
server is dump/restore, not a rewrite:

```
eil db export --out corpus.dump      # from embedded
eil db import --in corpus.dump       # into server, migrations applied first
eil db verify                        # row counts, hashes, capability re-probe
```

This has to be a **tested command with a verification step**, exercised in CI
against both profiles from the beginning. A migration path that has never been
run is not a migration path.

### 3.5 The rule that keeps the profiles honest

**No profile-specific SQL. Anywhere.**

If something genuinely needs to differ, it goes behind a *capability* check, not
a *profile* check. `if (profile === 'embedded')` is the beginning of two
divergent codebases; `if (capabilities.vector)` is a feature test that stays
true wherever it holds.

CI runs the full test suite against both profiles. Any divergence is a bug in
the data-access layer, not a fact about the profiles.

---

## 4. What changes in the plan

| Doc | Change |
|---|---|
| [03](03-data-model.md) | `scopes` + `document_scopes` + `capabilities`; cursor moves scope-level; stubs |
| [04](04-ingestion-and-delta.md) | Scope-driven sync; per-scope cursors, schedules and failure isolation; poll demoted to a per-scope schedule option |
| [06](06-retrieval.md) | Exact vector scan as the shipped implementation; funnel retained as documented-not-built |
| [07](07-scale-and-capacity.md) | Two capacity models — scoped and whole-instance — with the ~1M-chunk threshold between them |
| [13](13-system-diagram-and-tech-stack.md) | Storage profiles; capability detection replaces extension assumptions |
| [15](15-open-questions-and-delivery-plan.md) | F7 partially answered; P3-4 downgraded; scope tasks added; identity plane phase-gated to platform mode |

**F7 is now partly answered**: embedded exists today, hosted is obtainable.
The remaining question is narrower and still worth asking — *what does the
hosted option cost, who administers it, and which extensions come with it?*

---

## 5. Why this is the right change

Three reasons, in order of how much they matter:

1. **It makes the corpus intentional.** A crawled corpus is whatever the crawler
   reached. A scoped corpus is a set of decisions, each attributable, each
   reversible, each explainable to a reviewer.
2. **It deletes the hardest workstream.** Approximate vector search with
   calibrated recall is the most subtle machinery in this design and the easiest
   to get quietly wrong. Scoping removes the need for it rather than making it
   easier.
3. **It removes the last hard dependency on approvals.** Embedded storage plus
   scoped ingestion means a working, useful system on a laptop with no
   provisioning, no service account and no security review — while remaining the
   same codebase that scales up when those arrive.
