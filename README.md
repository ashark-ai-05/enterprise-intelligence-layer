# Enterprise Intelligence Layer

One searchable index across Confluence, Jira, Bitbucket and documents. Lexical,
graph and (soon) semantic retrieval, fused and ACL-correct at query time. Delta
ingestion from explicitly chosen scopes. Runs behind a corporate proxy with no
admin rights.

---

## Run this first, on the corporate machine

**No install. No pnpm, no npm, no `node_modules`.** Node builtins only.

```bash
git clone https://github.com/ashark-ai-05/enterprise-intelligence-layer
cd enterprise-intelligence-layer

node scripts/probe.mjs
```

Set whichever values are known. Anything unset is **skipped, never guessed**:

```bash
EIL_CONFLUENCE_URL=https://wiki.corp.example \
EIL_JIRA_URL=https://jira.corp.example \
EIL_BITBUCKET_URL=https://bitbucket.corp.example \
EIL_MAAS_URL=https://maas.corp.example/v1 \
EIL_MAAS_TOKEN=… \
  node scripts/probe.mjs
```

It reports **evidence, not opinions**, and exits non-zero on a failure:

```
✓ Node.js 22 or newer     process.version = v24.18.0
✓ Proxy environment       proxy = http://proxy.corp.example:3128
✓ Confluence reachable    https://wiki.corp.example → HTTP 401 in 240ms
                          → Connectivity confirmed; this status is about credentials, not the network.
– Corporate TLS bundle    NODE_EXTRA_CA_CERTS unset
                          → If the proxy intercepts TLS, every HTTPS request fails with a
                            self-signed-certificate error until this is set.
– MaaS serves embeddings  EIL_MAAS_URL not set

3 passed, 0 failed, 2 skipped
A skip is an unknown, not a pass. Each one is a fact still worth establishing.
```

**Paste that output back.** It settles several open questions — whether semantic
search runs locally or against the model endpoint, whether connectors can reach
their sources at all, and whether the runtime needs the proxy shim.

### Why a separate script instead of `pnpm doctor`

The first thing a locked-down machine breaks is the package manager, and these
facts are needed *before* anything can be installed. `scripts/probe.mjs` has no
dependencies for exactly that reason.

One thing it demonstrates rather than asserts: **Node's `fetch` ignores
`HTTPS_PROXY`.** Verified on Node 24 —

| | result |
|---|---|
| `HTTPS_PROXY=…` alone | request goes **direct**, proxy silently ignored |
| `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…` | routed through the proxy |

The probe sets the flag itself, so it measures the path a real client takes. On
a machine where the proxy is mandatory, the first form does not error — it hangs
until timeout and reads as "the source is slow".

---

## If the package manager is broken

Ordered by how much has to work. Stop at the first that succeeds.

```bash
node scripts/probe.mjs        # nothing needs to work
corepack pnpm install         # ships with Node; no separately installed pnpm
npm install                   # if npm is healthy
pnpm install                  # the normal path
```

`Failed to load npm builtin configs` comes from pnpm *before* any of this
project's code runs. `corepack pnpm` is the usual fix, because it uses the
version pinned in `package.json` rather than a global shim.

---

## Run it locally

Self-contained: embedded PGlite in a temp directory, no external services, no
credentials, no admin install.

```bash
pnpm install
pnpm demo          # ~300 synthetic objects end to end, ~6s
pnpm check         # lint, strict typecheck, full test suite, build
pnpm doctor        # the probe's checks, via the built CLI
```

Serve the tool surface to Amp, Copilot or Claude Code over MCP stdio:

```bash
pnpm build
node dist/cli.js serve
```

```jsonc
// .vscode/mcp.json  or  Claude Code MCP config
{ "servers": { "eil": { "type": "stdio", "command": "node",
                        "args": ["/abs/path/to/dist/cli.js", "serve"] } } }
```

Tools: `search_enterprise`, `get_evidence`, `list_containers`, `get_freshness`.
All read-only — mutations stay with the source systems.

---

## What works today

Everything below runs on **synthetic data**. No live source is connected yet.

| | |
|---|---|
| Storage | Embedded PGlite by default, hosted PostgreSQL via `DATABASE_URL`, one migration chain, no required extensions |
| Ingestion | Explicit scopes, per-scope cursors, content/metadata/ACL change gates, tombstones, reconciliation, durable job queue with leases and DLQ |
| Security | Container ACLs by reference, sparse resource and chunk overrides, deny-wins, fail-closed, authorization-domain principal mapping |
| Retrieval | Lexical + graph expansion, RRF fusion, source-diversity cap, publication gating |
| Serving | MCP over stdio, four read tools behind one audited choke point |
| Embeddings | Vendored MiniLM (384-dim), offline via WASM — **written but not yet retrieved over** |

### How good is retrieval, honestly

`recall@10 0.983` on the synthetic corpus, and that number is **narrower than it
looks**: the corpus generator derives its relevance judgments from the same link
edges the graph arm walks, so it largely measures link-following. Not one
generated wiki page yields a query that discriminates it from its peers, so
**prose relevance is currently unmeasurable**. A test asserts this and will fail
once the corpus gains distinguishable prose. See `docs/09-evaluation.md`.

---

## Design

`docs/` is the decision record and remains current: architecture, ingestion and
delta, ACL model, retrieval, scale, evaluation, risks, plus ADRs 0001–0012 for
the load-bearing choices.

Start with [`docs/15`](docs/15-open-questions-and-delivery-plan.md) for the
current architecture and open questions, and
[`docs/adr/0009`](docs/adr/0009-proxy-and-no-install-runtime.md) for the
constraint checklist the probe implements.
