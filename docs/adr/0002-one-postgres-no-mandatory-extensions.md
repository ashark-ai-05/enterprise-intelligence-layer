# ADR-0002 — One Postgres, no mandatory extensions, no new infrastructure

**Status**: Proposed · **Date**: 2026-08-11 · **Adopted from**: `eil`, unchanged

---

## Context

The obvious stack for enterprise search is Elasticsearch or OpenSearch for
lexical, a vector database for semantic, Redis for caching and Kafka for
ingestion. Every one of those is a separate installation, a separate approval, a
separate operational burden — and installation is exactly what is forbidden
([01](../01-context-and-constraints.md) §2).

Even where a managed equivalent could be procured, each additional system is an
independent procurement cycle in an organisation where those are the long pole.

---

## Decision

**Everything in one Postgres. No extension is required for correctness. Any
extension that is available is used as an optimisation with a working
fallback.**

Concretely:
- Lexical: `tsvector` + GIN, with BM25 computed from `lexeme_stats` /
  `corpus_stats` / `chunks.len` rather than requiring `pg_search`
- Semantic: `float4[]` with a `varbit` binary signature and IVF centroids,
  rather than requiring `pgvector`
- Queue: `FOR UPDATE SKIP LOCKED` with fenced leases, rather than a broker
- Cache: the buffer cache, rather than Redis
- Metrics: SQL views over the audit log, rather than a metrics pipeline

---

## Rationale

**One approval instead of six.** In this environment the number of distinct
systems requiring sign-off is a better predictor of delivery date than any
technical property. Postgres arrives as a DSN — procurement, not installation.

**Splitting the index splits the permission model.** A separate vector database
must either duplicate ACL data (which then drifts, independently, in a second
place) or return unfiltered candidates that are filtered afterwards — which
destroys recall in exactly the way [ADR-0007](0007-container-first-acl-prefilter.md)
exists to avoid. Keeping vectors beside the ACEs they are filtered by is not a
compromise; it is the correct topology for this problem.

**Transactional consistency is free here and expensive elsewhere.** A document,
its chunks, its vectors, its ACEs and its link edges commit together. Two stores
means reconciling two systems that disagree, and the disagreement is always
discovered by a user.

**The workload does not demand more.** Single-digit peak QPS against ~105 GB
([07](../07-scale-and-capacity.md)). Elasticsearch's distributed architecture
solves a problem this workload does not have, at a cost this environment cannot
absorb.

**PGlite makes zero-install real.** Real Postgres compiled to WASM, running
in-process from `node_modules` — the same SQL, the same schema, no server, no
admin rights. That is what makes personal mode approval-free, and personal mode
is the adoption strategy ([12](../12-risk-register.md) R2).

---

## Consequences

**Accepted**
- BM25 must be implemented rather than inherited. `eil` has already built the
  apparatus; the remaining work is the eval gate that makes switching safe.
- Vector search needs the signature-and-IVF funnel with mandatory exact rescore.
  More engineering than `CREATE INDEX ... USING hnsw`, and it is a solved
  problem with calibration already done.
- A single node is a single point of failure. Mitigated by replicas and by
  personal mode continuing to work when the platform is down.
- Some genuinely useful Elasticsearch features (aggregations over full text,
  percolators, phrase suggesters) are unavailable. None are required.

**Upgrade paths, all additive**
- `pgvector` available → HNSW replaces the funnel; the funnel stays as the
  fallback for deployments without it
- `pg_search` available → true BM25 without the manual apparatus
- Neither is blocking, and **the design must not be built assuming either will
  arrive**

**Explicitly not chosen**
- *SQLite / FTS5.* No concurrent writers, no server mode, and the native
  driver is a native build.
- *A vector DB for the semantic arm only.* Splits the ACL model — the specific
  failure this ADR exists to prevent.
- *Kafka.* 0.6 writes/second. The queue is a table.
