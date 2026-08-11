# Enterprise Intelligence Layer — Architecture

One index across Confluence, Jira, Bitbucket, code, notes and PDFs. Hybrid
lexical + semantic retrieval. Delta ingestion. ACL-correct at query time.
Runs behind a corporate proxy with no admin rights on the machine.

The phased implementation is now underway. Architecture documents remain the
decision record; executable code lands only after its milestone acceptance
suite passes.

## Implementation status

The first foundation slice provides:

- embedded PGlite by default and hosted PostgreSQL through `DATABASE_URL`;
- one extension-free migration chain and database contract;
- conservative runtime capability detection;
- explicitly allowlisted Confluence, Jira, Git/Bitbucket, and file scopes;
- independent per-scope cursors and refresh modes;
- resource deduplication across overlapping scopes;
- explicit retain-versus-purge removal with tenant-bound mutations.

```bash
pnpm install
pnpm check
```

`pnpm check` runs formatting/lint, strict TypeScript, the full PGlite
integration suite, and a production build. Hosted PostgreSQL acceptance will
be added when a test instance is available; no server-only capability is
assumed by the embedded profile.

**Try it now:**

```bash
pnpm demo
```

Self-contained — an embedded PGlite database in a throwaway temp directory,
zero external services, zero credentials, zero admin install. It exercises
real, merged code (storage, scope registry, rank fusion, diversity cap,
doctor checks) end to end; only the Confluence/Jira *content* is a fixture,
because no live connector has landed yet. `src/demo/run.ts` is meant to be
extended rather than rewritten — each fixture block gets swapped for real
connector/MCP output as that lands, and CI runs the demo on every push/PR so
it can't silently rot. Runs on any machine with Node 22+; no proxy, no
network, no corp credentials required.

CI is enabled — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
Every push to `main` and every PR runs `pnpm check` plus the demo smoke test.

---

## Read this first

The single most expensive mistake available here is building the wrong thing
competently. Three framing decisions do more to determine success than every
implementation detail combined:

1. **The MCP tools you already have are not the ingestion path.** They are the
   *escalation* path. Live tools answer "what is true right now"; the index
   answers "where is the thing, and what did it say". Feeding bulk ingestion
   through question-shaped MCP tools will be slow, rate-limited and lossy.
   → [ADR-0008](docs/adr/0008-mcp-tools-are-escalation-not-ingestion.md)

2. **Whose identity the index belongs to decides whether this is a toy or a
   platform.** Personal-credential ingestion has perfect ACL fidelity and dies
   at roughly 20 users. A shared index needs mirrored permissions, and mirrored
   permissions are the thing that leaks. This is the decision to make on day 1,
   not month 6. → [ADR-0001](docs/adr/0001-shared-index-with-stamped-acls.md)

3. **Search quality you cannot measure is search quality you cannot defend.**
   Without a labelled query set, every ranking change is a coin flip and every
   complaint is unfalsifiable. → [Evaluation](docs/09-evaluation.md)

Everything else follows from these.

---

## Document map

### Design
| Doc | What it settles |
|---|---|
| [01 — Context & constraints](docs/01-context-and-constraints.md) | What is actually true about the environment, and what each constraint forbids |
| [02 — Architecture](docs/02-architecture.md) | The seven planes, the request paths, the failure modes |
| [03 — Data model](docs/03-data-model.md) | Canonical document, chunk, ACL graph, link graph. Reference DDL |
| [04 — Ingestion & delta](docs/04-ingestion-and-delta.md) | The Source Feed Contract, change detection, deletions, backfill vs live |
| [05 — ACL & security](docs/05-acl-and-security.md) | Permission mirroring per source, deny-wins evaluation, freshness SLA, red team |
| [06 — Retrieval](docs/06-retrieval.md) | Five arms, fusion, reranking, latency budget, query routing |
| [07 — Scale & capacity](docs/07-scale-and-capacity.md) | Sizing at 2M docs / 20M chunks, the vector funnel, partitioning, when to shard |
| [08 — Serving & front doors](docs/08-serving-and-front-doors.md) | MCP stdio/HTTP, REST, reporting, per-request identity |
| [09 — Evaluation](docs/09-evaluation.md) | Golden sets, bootstrapping labels, the regression gate |
| [10 — Operations](docs/10-operations.md) | Metrics that matter, data-trust auditing, runbooks, on-call |
| [11 — Roadmap](docs/11-roadmap.md) | Five phases with explicit exit gates |
| [12 — Risk register](docs/12-risk-register.md) | What actually kills this, ranked, with mitigations |
| [13 — System diagram & tech stack](docs/13-system-diagram-and-tech-stack.md) | The whole system on one page, every component's technology and its fallback, and the two extension seams |
| [14 — Prior art, gaps & pre-build changes](docs/14-prior-art-gaps-and-pre-build-changes.md) | What Onyx, ManifoldCF, Elastic and Sourcegraph already solved; 13 gaps in this design; what to change and what to cut before writing code |
| [15 — Open questions & delivery plan](docs/15-open-questions-and-delivery-plan.md) | The revised eight-plane architecture, 26 open questions each with a recommended default, and the task breakdown with sizes, dependencies and the critical path ([`tasks/TASKS.tsv`](tasks/TASKS.tsv)) |
| [16 — Scoped ingestion & storage profiles](docs/16-scoped-ingestion-and-storage-profiles.md) | Explicit scopes replace whole-instance crawling; embedded and hosted Postgres as one schema. Collapses capacity by ~100× and removes approximate vector search from the build |

### Decisions
| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-shared-index-with-stamped-acls.md) | Shared index with stamped ACLs, not per-user indexes |
| [0002](docs/adr/0002-one-postgres-no-mandatory-extensions.md) | One Postgres, no mandatory extensions, no new infrastructure |
| [0003](docs/adr/0003-source-feed-contract.md) | Every connector implements one Source Feed Contract |
| [0004](docs/adr/0004-two-hash-change-detection.md) | Two hashes (content + metadata), not one |
| [0005](docs/adr/0005-local-first-embeddings.md) | Local-first embeddings; MaaS is opt-in and never in the hot path |
| [0006](docs/adr/0006-hybrid-retrieval-rrf.md) | Rank fusion over score blending; no model in the retrieval path |
| [0007](docs/adr/0007-container-first-acl-prefilter.md) | Container-first ACL pre-filter to keep ANN viable |
| [0008](docs/adr/0008-mcp-tools-are-escalation-not-ingestion.md) | Existing MCP tools serve the live lane, not the index lane |
| [0009](docs/adr/0009-proxy-and-no-install-runtime.md) | Pure-JS/WASM runtime, explicit proxy dispatch, vendored models |
| [0010](docs/adr/0010-what-not-to-index.md) | Logs, metrics and dashboards are referenced, not indexed |
| [0011](docs/adr/0011-scope-driven-ingestion.md) | Ingestion is scope-driven, not crawl-driven |
| [0012](docs/adr/0012-storage-profiles.md) | Two storage profiles (embedded, server), one schema |

---

## Relationship to `eil`

[`ashark-ai-05/eil`](https://github.com/ashark-ai-05/eil) is the working
prototype and it is considerably better than "a first draft". It already has
the canonical document model, extension-free vector storage with a calibrated
IVF funnel, fail-closed ACL predicates composed into every arm, temporal
validity, a fenced job queue, and a data-trust audit. Several of its decisions
are load-bearing here and are adopted rather than revisited.

What this design changes is **the things that only break at organisational
scale**, where a laptop-shaped answer stops being the right answer:

| Area | `eil` today | Here | Why |
|---|---|---|---|
| Index identity | Per-user, personal credentials | Shared, service-account ingest, mirrored ACLs | O(users × corpus) does not scale past a team |
| ACL expression | `acl_groups jsonb`, allow-only | Principal graph, ALLOW/DENY ACEs, deny-wins | Confluence restrictions and Jira issue security are subtractive; allow-only cannot express them |
| Change detection | `sha256(body)` | `content_hash` + `meta_hash` | A page move changes inherited restrictions and no body bytes |
| Group membership | Stamped at ingest | Resolved at query time from the directory | Membership churns hourly; page restrictions churn monthly. Different problems, different SLAs |
| ANN + ACL | ACL predicate around the vector scan | Container-set pre-filter, then scan | Post-filtering an ANN result destroys recall; pre-filtering an unpartitioned index destroys the index |
| Jira chunking | Prose chunker | Thread-aware (description / per-comment / synthesized state) | An issue is a conversation, not a page |
| Logs | `fetch_logs` indexed read path | Not indexed; definitions and runbooks indexed, lines fetched live | Log volume dwarfs the rest of the corpus and is stale on arrival |

Nothing in `eil` is deleted by this design. The migration is additive and is
sequenced in [the roadmap](docs/11-roadmap.md).

---

## Status

Design under review. Nothing here has been implemented, benchmarked in this
environment, or approved by a security review. Numbers marked **(measured)**
come from the `eil` repository's own calibration notes; numbers marked
**(estimated)** are arithmetic from stated assumptions and should be re-measured
before anyone commits to them.
