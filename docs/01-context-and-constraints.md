# 01 — Context and constraints

Every constraint below is a design input, not a complaint. Each one is stated
with what it **forbids**, because a constraint you cannot act on is decoration.

---

## 1. The environment

| Fact | Consequence |
|---|---|
| Large organisation, corporate proxy on all egress | No library that ignores `HTTPS_PROXY` can be used unmodified |
| TLS interception likely | Custom CA bundle required; certificate pinning impossible |
| Cannot install unauthorised software | No Docker, no Elasticsearch, no Qdrant, no Redis, no Kafka, no native npm builds |
| MCP tools already exist for Jira, Confluence, Bitbucket, logs, Grafana | Reuse for the *live* lane; do not use as the bulk ingest transport |
| LLM access via Amp and GitHub Copilot | Developer-loop tools. Not a server-side API you can call from a worker |
| Models-as-a-service over HTTP, **beta** | Treat as unreliable and un-budgeted. Never a hard dependency |
| Requirement: semantic **and** text search across sources | Hybrid retrieval, not "vector database" |
| Requirement: delta ingestion, not full re-ingest | Change detection is a first-class subsystem, not an optimisation |
| Requirement: scalable, fast, searchable | Must state a latency budget and a capacity model, or the words mean nothing |

---

## 2. What "cannot install unauthorised software" actually forbids

This is the constraint most likely to be under-read, so it gets its own
section. It rules out more than it first appears.

**Forbidden**
- Container runtimes (Docker, Podman) — so no "just run Elastic in a container"
- Standalone servers requiring installation or admin (Elasticsearch, OpenSearch,
  Solr, Qdrant, Weaviate, Milvus, Redis, Kafka, RabbitMQ)
- npm packages with **native build steps or downloaded binaries**. This is
  subtle and it bites: `onnxruntime-node` downloads a platform binary at install
  time. `better-sqlite3` compiles. Both are effectively software installation
  wearing an `npm install` costume.
- System package installs (`apt`, `brew`, `choco`) — including
  `libsecret-tools`, which the `eil` prototype's Linux keychain path needs
- OCR toolchains (Tesseract, poppler-utils) — which removes scanned-PDF support

**Permitted**
- A JavaScript runtime already approved on the machine (Node)
- Pure-JS and **WebAssembly** npm packages from the approved internal registry.
  WASM is the loophole that matters: `web-tree-sitter`, `onnxruntime-web`,
  `pdf.js`, and PGlite are all pure downloads with no compilation.
- Postgres **as a provisioned service** — this is procurement, not installation.
  Someone else runs it; you get a DSN.
- Model weight files committed to the repository or fetched from an internal
  artifact store

**The practical consequence**: the entire platform must be expressible as
*Node + Postgres + WASM*, with Postgres arriving as a DSN rather than an
install. That is a severe constraint and it is also the design's greatest
strength — one dependency to get approved instead of six.
→ [ADR-0002](adr/0002-one-postgres-no-mandatory-extensions.md),
[ADR-0009](adr/0009-proxy-and-no-install-runtime.md)

---

## 3. The corporate proxy

Three separate problems that get conflated:

**3.1 Egress routing.** Node's global `fetch` (undici) does **not** honour
`HTTPS_PROXY` / `HTTP_PROXY` environment variables. Nothing warns you; requests
to internal hosts succeed, requests to anything requiring the proxy hang until
timeout. A `ProxyAgent` must be installed explicitly as the global dispatcher,
and `NO_PROXY` must be honoured manually because the agent does not parse it.

**3.2 TLS interception.** If the proxy terminates TLS, every certificate is
signed by an internal CA. `NODE_EXTRA_CA_CERTS` pointing at the corporate
bundle is the correct fix. Disabling verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`)
is not — it will be found in a security review and it will end the project.

**3.3 The package registry.** `pnpm install` must resolve through the internal
mirror (Artifactory/Nexus), which means an `.npmrc` with the registry and, on
TLS-intercepting proxies, the CA. If a package is not mirrored, it does not
exist. **Verify every intended dependency is present in the mirror before
designing around it.**

Additionally: proxies commonly cap connection lifetime and idle time. Long-lived
keepalive connections will be severed mid-stream. Every source call must be
idempotent and retried with backoff on connection-reset, not just on HTTP 5xx.

---

## 4. The models-as-a-service endpoint

A beta HTTP endpoint is a **capability**, not a dependency. Design rules:

- **Never in the retrieval hot path.** A search that cannot complete when the
  beta endpoint is down is a search that is down.
- **Circuit-breaker and budget-capped.** Trip open on error rate; cap spend per
  day per tenant; degrade to the non-model path rather than queue.
- **Data egress is a governance question, not a technical one.** Sending
  Confluence body text to an embedding endpoint moves organisational data to
  another system. Whether that is permitted depends on where the endpoint runs
  and what its retention policy is. **Establish this before designing around
  it** — the answer determines whether embeddings are computed locally or
  remotely, which is a foundational choice.
  → [ADR-0005](adr/0005-local-first-embeddings.md)

The safe default that survives either answer: **embed locally**, and reserve
MaaS for optional reranking and offline enrichment where the value is high and
the volume is low.

---

## 5. Amp and GitHub Copilot are not server-side LLM access

Worth stating plainly because it is easy to assume otherwise. Both are
interactive developer tools bound to an IDE or CLI session. They are excellent
for:

- Generating the initial golden query set from the corpus (offline, one-off)
- Writing connectors and reviewing this design
- Being *clients* of the finished MCP server

They are not suitable for:

- Per-request enrichment in a serving path
- Bulk summarisation of two million documents

If server-side generation is needed, it comes from the MaaS endpoint under the
constraints in §4, or it does not happen.

---

## 6. Scale assumptions

These drive every sizing decision downstream and should be replaced with real
numbers as soon as they are available. Stated so the arithmetic is auditable.

| Source | Items | Assumption |
|---|---|---|
| Confluence | 500k – 2M pages | Large org, many years, heavy duplication |
| Jira | 1M – 5M issues | Includes closed; most value is in the last 24 months |
| Bitbucket | 3k – 8k repos | Only a curated subset indexed — see [ADR-0010](adr/0010-what-not-to-index.md) |
| PDFs / notes | 50k – 200k | Highly variable; the long tail is low value |
| Logs / metrics | Effectively unbounded | **Not indexed.** Definitions and runbooks only |

**Working target: ~2M documents, ~20M chunks.** This is the number the capacity
model in [07](07-scale-and-capacity.md) is built against, and it is the same
target the `eil` prototype calibrated its vector funnel for.

Users: 50 at pilot, 500 – 5,000 at organisational rollout. Query volume is
modest — a few queries per user per day — which matters, because it means
**this is a latency problem, not a throughput problem**. Design accordingly.

---

## 7. Non-goals

Stated to prevent scope creep, which is the second most likely cause of failure
after ACL drift.

- **Not a chat product.** It is a retrieval layer. Chat UIs are consumers.
- **Not a system of record.** The sources remain authoritative. The index is a
  cache that must be able to say how stale it is.
- **Not a write path.** No creating tickets, editing pages, or merging PRs.
  Those stay with the existing live MCP tools, where the audit trail already
  exists.
- **Not a log aggregator.** → [ADR-0010](adr/0010-what-not-to-index.md)
- **Not multi-organisation SaaS.** Tenancy exists in the schema as a safety
  boundary and a migration hedge, not as a product.
