# Enterprise Intelligence Layer

One index across Confluence, Jira, Bitbucket, and code. Hybrid lexical +
graph-expansion retrieval, ACL-correct at query time, served over MCP. Built
to run behind a corporate proxy with no admin rights on the machine.

The platform runs end to end today — ingestion, chunking, ACLs, publication,
retrieval, evaluation, MCP serving — against stub connectors and a synthetic
corpus. The only thing missing is real Confluence/Jira/Bitbucket source data,
which is gated entirely on the facts below.

---

## Run this on your corp machine

This is the highest-value five minutes available — it settles whether the
proxy works, whether the package mirror resolves, whether MaaS serves
embeddings, and it's the gate on swapping stub connectors for real ones.

```bash
git clone https://github.com/ashark-ai-05/enterprise-intelligence-layer.git
cd enterprise-intelligence-layer
pnpm install
```

```bash
EIL_CONFLUENCE_URL=https://your-org.atlassian.net/wiki \
EIL_JIRA_URL=https://your-org.atlassian.net \
EIL_BITBUCKET_URL=https://your-bitbucket-host \
EIL_MAAS_URL=https://your-maas-endpoint \
EIL_MAAS_TOKEN=... \
pnpm doctor
```

Each source URL is optional and independently probed — set only the ones you
have. `pnpm doctor` also reports `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`/
`NODE_EXTRA_CA_CERTS` and whether `onnxruntime-node`'s native binary was
pulled in by mistake (it shouldn't be — this repo only uses the WASM
backend). Paste the full output back, not a summary — a `–` (skip) is a fact
still worth having, not a pass.

```bash
pnpm demo            # ~300 objects through the full pipeline, ~5s, zero setup
pnpm demo:stress     # ~5,000 objects, ~25s
node dist/cli.js serve   # MCP tool surface over stdio — point Amp/Copilot/Claude Code at this
```

`pnpm demo` needs nothing from the section above — it runs entirely on
embedded PGlite with stub connectors and a generated corpus, so it works
identically on a laptop and on a locked-down corp machine. `pnpm doctor` is
what tells us whether the *real* sources are reachable from where you are.

---

## What's built

Storage (embedded PGlite or hosted Postgres via `DATABASE_URL`), scope
registry, scoped stub ingestion for Confluence/Jira/Bitbucket, structural
chunking with chunk-level ACL overlays, offline WASM embeddings (vendored
MiniLM model, no network call), atomic index-generation publication,
ID-diff reconciliation, principal mapping with deny-wins fail-closed
authorization, durable fenced jobs with retry/DLQ and scheduling, indexed
lexical + persisted graph-expansion retrieval arms, a measured ranking
regression gate wired into CI, and an MCP tool surface (`search_enterprise`,
`get_evidence`, `list_containers`, `get_freshness`) served over stdio with
query auditing. All of it CI-gated on every push and PR — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

What isn't built: real Confluence/Jira/Bitbucket connectors (stubs stand in
today), a durable audit table (the `AuditSink` interface has only an
in-memory implementation), and a semantic/vector retrieval arm (embeddings
are computed and stored but nothing queries them yet — deliberately
deferred until the corpus can measure prose relevance, not just link-walking
and identifier matching).

---

## Read this first

Three framing decisions do more to determine success here than any
implementation detail:

1. **The MCP tools you already have are not the ingestion path.** They are
   the *escalation* path — live tools answer "what is true right now"; the
   index answers "where is the thing, and what did it say". Feeding bulk
   ingestion through question-shaped MCP tools is slow, rate-limited, and
   lossy. → [ADR-0008](docs/adr/0008-mcp-tools-are-escalation-not-ingestion.md)

2. **Whose identity the index belongs to decides whether this is a toy or a
   platform.** Personal-credential ingestion has perfect ACL fidelity and
   dies at roughly 20 users. A shared index needs mirrored permissions, and
   mirrored permissions are the thing that leaks. → [ADR-0001](docs/adr/0001-shared-index-with-stamped-acls.md)

3. **Search quality you cannot measure is search quality you cannot
   defend.** Without a labelled query set, every ranking change is a coin
   flip. → [Evaluation](docs/09-evaluation.md)

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
| [13 — System diagram & tech stack](docs/13-system-diagram-and-tech-stack.md) | The whole system on one page, every component's technology and its fallback |
| [14 — Prior art, gaps & pre-build changes](docs/14-prior-art-gaps-and-pre-build-changes.md) | What Onyx, ManifoldCF, Elastic and Sourcegraph already solved; gaps in this design |
| [15 — Open questions & delivery plan](docs/15-open-questions-and-delivery-plan.md) | Open questions with recommended defaults, task breakdown ([`tasks/TASKS.tsv`](tasks/TASKS.tsv)) |
| [16 — Scoped ingestion & storage profiles](docs/16-scoped-ingestion-and-storage-profiles.md) | Explicit scopes replace whole-instance crawling; embedded and hosted Postgres as one schema |

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
personal-scale prototype this design builds on; several of its decisions
(extension-free vector storage, fail-closed ACL predicates, temporal
validity) are adopted rather than revisited. What changed here is what only
breaks at organizational scale — shared-index identity instead of
per-user credentials, a subtractive ALLOW/DENY ACL model instead of
allow-only, and query-time group resolution instead of stamping membership
at ingest. Nothing in `eil` is deleted by this design.
