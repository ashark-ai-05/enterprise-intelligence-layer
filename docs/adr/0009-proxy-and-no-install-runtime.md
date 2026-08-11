# ADR-0009 — Pure-JS/WASM runtime, explicit proxy dispatch, vendored models

**Status**: Proposed · **Date**: 2026-08-11

---

## Context

The platform must run behind a corporate proxy on a machine where unauthorised
software cannot be installed. These are the constraints most likely to be
under-read at design time and to surface as a blocker in week nine.

---

## Decision

**The entire platform is expressible as Node + Postgres-as-a-DSN + WASM.
Outbound HTTP is dispatched through an explicitly configured proxy agent. Model
weights are vendored. Every dependency is verified present in the internal
registry before it is designed around.**

---

## Rationale and implementation

### 1. Node does not honour proxy environment variables

Node's global `fetch` (undici) ignores `HTTPS_PROXY` and `HTTP_PROXY`. Nothing
warns you. Requests to internal hosts succeed and requests requiring the proxy
hang until timeout, which reads as "the source is slow" rather than "the proxy
is not configured" — and that misdiagnosis can cost days.

The proxy agent must be installed as the global dispatcher, and **`NO_PROXY`
must be honoured in application code**, because the agent does not parse it.
Internal Confluence and Jira hosts are usually in `NO_PROXY`; routing them
through the proxy anyway will be slower at best and blocked at worst.

One shared HTTP client for all connectors — proxy, `NO_PROXY`, retry, backoff,
rate limiting and timeouts in one place. `eil` already has this shape
(`ts/connectors/httpclient.ts`) and it is the right one.

### 2. TLS interception

If the proxy terminates TLS, every certificate is signed by an internal CA.
`NODE_EXTRA_CA_CERTS` pointing at the corporate bundle is the correct fix.

**Disabling certificate verification is not an acceptable alternative.** It will
be found in a security review, and it converts a configuration task into a
project-ending finding.

### 3. Connections are severed

Corporate proxies cap connection lifetime and idle time. Long-lived keepalive
connections will be cut mid-request. Every source call must be idempotent and
retried on connection-reset — not only on HTTP 5xx, which is the usual and
insufficient retry predicate.

### 4. The package registry is the real gate

`pnpm install` resolves through the internal mirror. **A package that is not
mirrored does not exist.** Verify the complete dependency tree in week 1
([11](../11-roadmap.md)) — this is cheap to check and expensive to discover late.

### 5. No native builds

Packages with native compilation or install-time binary downloads are software
installation wearing an `npm install` costume. The specific one that matters:
`onnxruntime-node`, which `@huggingface/transformers` depends on, downloads a
platform binary.

**WASM is the loophole that makes this design possible**: `onnxruntime-web`,
`web-tree-sitter`, `pdf.js` and PGlite are all pure downloads with no
compilation step. Where a WASM alternative exists, prefer it even at a
performance cost — an available slower path beats a blocked faster one.

Install with `--ignore-scripts` in the target environment and confirm the
platform still functions. If it does not, a native dependency is hiding.

### 6. Vendored models

Model weights live in the repository. No hub call, no download at runtime, works
air-gapped. ~23 MB for the 384-dimension quantised embedder — acceptable in git,
and `eil` already does this.

### 7. Postgres is procured, not installed

PGlite (WASM) for personal mode; a provisioned DSN for platform mode. Neither
requires admin rights on the machine.

---

## Consequences

**Accepted**
- Some best-in-class libraries are unavailable. Usually a WASM or pure-JS
  equivalent exists at some performance cost.
- WASM ONNX inference is meaningfully slower than native, lengthening the
  embedding backfill. It is a one-off cost paid in the backfill lane.
- Vendored model weights add ~23 MB to the repository.

**Verification checklist for week 1** — each item is a fact, not a judgement,
and each can invalidate a design assumption:

- [ ] `pnpm install --ignore-scripts` succeeds from the internal registry
- [ ] Every intended dependency resolves through the mirror
- [ ] A proxied request to Confluence succeeds from the target machine
- [ ] A proxied request to Jira succeeds
- [ ] `NODE_EXTRA_CA_CERTS` resolves the corporate CA correctly
- [ ] `NO_PROXY` correctly bypasses internal hosts
- [ ] The ONNX runtime — native or WASM — loads and produces a vector
- [ ] PGlite starts and runs a migration with no admin rights
- [ ] The MaaS endpoint is reachable, and its data-retention policy is known

The last item is a governance answer, not a technical one, and it gates
[ADR-0005](0005-local-first-embeddings.md).
