# ADR-0011 — Ingestion is scope-driven, not crawl-driven

**Status**: Proposed · **Date**: 2026-08-11 · **Supersedes** the whole-instance
crawl assumption in [04](../04-ingestion-and-delta.md) and
[07](../07-scale-and-capacity.md)

---

## Context

Every design in this thread assumed the corpus is *everything the credential can
reach*: crawl the Confluence instance, crawl the Jira instance, index the repos,
then poll for deltas forever. That assumption drove the capacity model (2M
documents, 20M chunks), which drove approximate vector search, which drove
IVF calibration and binary quantisation.

The requirement is different: **name the spaces, pages, projects, filters,
repositories and subtrees to ingest.**

---

## Decision

**A `scope` is the unit of configuration, sync, removal and audit.** Nothing is
ingested that is not inside an enabled scope.

```
scope = (source, selector_kind, selector, recursive, trigger, schedule)
```

Cursors move from source-level to **scope-level**. Each scope syncs on its own
clock with its own cursor and its own failure state.

Triggers are `manual` (default), `scheduled` (per-scope interval), or
`on-reference` (queued when retrieval surfaces a link into unindexed material).

---

## Consequences

### Intended

- **Capacity falls ~2 orders of magnitude**: ~20k–80k documents, ~200k–800k
  chunks, ~300 MB–1.2 GB of vectors.
- **Exact vector scan becomes correct**, and approximate search becomes
  unnecessary → see below.
- **The corpus becomes intentional and auditable.** `scopes` is a short,
  exportable list of exactly what has been copied and by whom — the artefact a
  privacy reviewer or a Confluence admin asks for.
- **Failure isolates.** A throttled space does not stall a Jira project.
- **Monorepos become tractable** via subtree selectors, without indexing 20M
  lines to answer questions about one service.

### The workstream this deletes

Below ~1M chunks, a sequential exact scan over `float4[384]` is tens of
milliseconds and *exact*. That removes IVF centroid training, `nprobe`
calibration, binary quantisation (measured at 63.5% recall@10 on 384 dims), the
two-stage rescore, and **silent recall drift as the corpus grows** — the failure
mode nobody detects until results have quietly been worse for a month.

The funnel design stays written in [06](../06-retrieval.md), unbuilt, for the
day a scope set crosses ~1M chunks.

**Not indexing something is faster than indexing it cleverly.** This is a better
performance decision than any technique in the design.

### Costs and hazards

- **Coverage is now a user responsibility.** A question whose answer lives
  outside every scope returns nothing, and "not indexed" is indistinguishable
  from "does not exist" unless surfaced. Mitigations: out-of-scope **stubs** so
  references resolve, the federated arm as the live fallback, and
  reference-count ranking of unindexed material as the scope backlog.
- **Removal must refcount.** A document reachable from two scopes must survive
  removal of one. `document_scopes` is a many-to-many table for exactly this
  reason; purge only at refcount zero.
- **`scope remove` must not imply delete.** Unsubscribing and destroying data
  are different intentions; `--purge` is explicit.
- **Stubs carry titles, and titles are ACL-bearing.** Safe in personal mode,
  requires an ACE in platform mode.

### What this does not change

Delta detection, the three-hash gate, cursors, tombstones, reconciliation
sweeps and connector certification all still apply — to a chosen set rather than
to everything. Scoping changes *what* is synced, never *whether* deltas are
computed correctly.

---

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Crawl everything, filter on read | Maximum ingestion cost, maximum ACL surface, maximum governance difficulty, and it is the version that needs approximate vector search |
| Crawl everything, allow-list at index time | Same crawl cost and rate-limit exposure; only saves storage |
| Scope by ACL ("index what I can read") | In a large org that is most of the instance — not a scope, a crawl with extra steps |
