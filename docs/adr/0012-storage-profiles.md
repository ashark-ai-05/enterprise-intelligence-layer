# ADR-0012 — Two storage profiles, one schema

**Status**: Proposed · **Date**: 2026-08-11 · **Refines**
[ADR-0002](0002-one-postgres-no-mandatory-extensions.md)

---

## Context

An embedded Postgres (PGlite) is available locally today. A hosted Postgres is
obtainable but not yet provisioned. The system must run usefully on the first
and scale onto the second without a rewrite.

---

## Decision

**Two profiles, one schema, one migration chain, one SQL dialect.**

| | `embedded` | `server` |
|---|---|---|
| Engine | PGlite (WASM Postgres) | PostgreSQL 16 + replicas |
| Connections | **One** — single-user mode | Pool |
| Workers | In-process loop, concurrency 1 | N processes |
| Extensions | `pgvector` via npm; others unlikely | Whatever is approved |
| Ceiling | ~1M chunks | Full capacity model |

Selection is one environment variable: `DATABASE_URL` absent → `embedded`.

---

## Consequences

### The concurrency constraint is real and shapes the code

PGlite is single-user, single-connection **by design** — Emscripten cannot fork,
so Postgres is compiled in single-user mode. v0.4 multiplexes callers over that
one connection; it does not create a second process.

Two rules follow, both cheap now and expensive later:

1. **The job queue must be correct at concurrency 1.** `FOR UPDATE SKIP LOCKED`
   with fenced leases already is — it degrades to a plain work loop. A broker
   would not have degraded so gracefully.
2. **One connection per request or job, for its whole lifetime.** Code that
   holds a transaction and asks for a second connection deadlocks under
   `embedded` and passes under `server`. Enforce in the data-access layer, not
   by discipline — it is invisible in whichever profile you develop against.

### Capabilities are detected, never configured

```sql
CREATE TABLE capabilities (name text PRIMARY KEY, available boolean, detected_at timestamptz);
```

Probed at boot: `vector`, `pg_trgm`, `pg_search`, `unaccent`, `skip_locked`.
Retrieval selects arms from this table. A missing capability disables an arm; it
never errors and never silently degrades correctness.

**A useful inversion**: `pgvector` may be *more* available under `embedded` (an
npm package) than under `server` (a DBA approval). Neither profile can be
assumed, which is exactly why the extension-free `float4[]` path in
[ADR-0002](0002-one-postgres-no-mandatory-extensions.md) stays the default.

### No profile-specific SQL, anywhere

`if (profile === 'embedded')` is the beginning of two codebases.
`if (capabilities.vector)` is a feature test. Only the latter is permitted, and
only inside the storage and search adapters.

CI runs the whole suite against both profiles. Divergence is a bug in the
data-access layer, not a fact about the profiles.

### Migration is a tested command

Identical schema means embedded → server is export/import, not a re-crawl:
`eil db export` · `eil db import` · `eil db verify` (row counts, hashes,
capability re-probe). Exercised in CI from the start — a migration path that has
never been run is not a migration path.

Credentials are never inside the database. They rebind from the local keychain
or the hosted secret store after migration.

---

## Alternatives rejected

| Alternative | Why not |
|---|---|
| SQLite locally, Postgres hosted | Two dialects, two sets of SQL, two behaviours for the same query. The whole benefit is that they are the same |
| Hosted Postgres only | Blocks all work on provisioning that has not happened |
| Embedded only | Caps the system at one user and ~1M chunks forever |
