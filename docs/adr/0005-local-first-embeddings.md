# ADR-0005 — Local-first embeddings; MaaS is opt-in and never in the hot path

**Status**: Proposed · **Date**: 2026-08-11

---

## Context

Semantic search needs embeddings for ~20M chunks and for every query. Two
sources are available: an in-process ONNX model, or the organisation's
models-as-a-service HTTP endpoint, which is **in beta**.

---

## Decision

**Bulk and query embedding run locally on a vendored ONNX model. The MaaS
endpoint is used only for optional reranking and offline enrichment, behind a
circuit breaker and a budget cap, always degrading rather than failing.**

---

## Rationale

**Data egress is a governance decision, not a technical one.** Embedding two
million documents means transmitting the organisation's knowledge to whatever
runs the endpoint. Whether that is permitted depends on where it runs and what
it retains — and the answer may take months to obtain. Local embedding makes the
question unnecessary on the critical path, which removes a dependency on an
approval the project does not control ([12](../12-risk-register.md) R2).

**Beta means unreliable, and the hot path cannot be.** A search that fails when
the beta endpoint is down is a search that is down. Query embedding is on the
hot path; therefore query embedding is local.

**Volume.** 20M chunks against a beta endpoint is a rate-limit conversation, an
unpredictable bill, and a multi-week dependency on someone else's capacity
planning. Local embedding on four workers is roughly seven hours of CPU that
nobody needs to approve ([07](../07-scale-and-capacity.md) §5).

**Determinism.** The same text must produce the same vector. A remote endpoint
that silently upgrades its model invalidates the entire index without telling
you, and the symptom is degraded recall with no deployment to correlate against.
A vendored model file cannot change underneath you.

**Cost.** Local embedding is CPU you already have. Per-token pricing over 20M
chunks is not.

**Where MaaS genuinely earns its place**: cross-encoder reranking is the single
largest quality lever ([06](../06-retrieval.md) §5), and it applies to ~50
candidates on opt-in queries — low volume, high value, non-critical. That is the
right shape for a beta dependency.

---

## Implementation notes

- **Vendor the model in the repository.** `all-MiniLM-L6-v2` quantised is ~23 MB
  at 384 dimensions. It travels with the code, never calls a public hub, and
  works on an air-gapped machine. `eil` already does this.
- **The runtime is the risk, not the model.** `@huggingface/transformers` uses
  `onnxruntime-node`, which downloads a platform binary at install time — that
  is software installation wearing an `npm install` costume, and it may be
  blocked ([01](../01-context-and-constraints.md) §2).
  **Fallback: `onnxruntime-web` (WASM)** — slower, no native artefact, and it
  keeps the semantic arm available under the strictest reading of the
  constraint. **Verify which of these is permitted in week 1**
  ([12](../12-risk-register.md) R5).
- **Model identity is part of the vector's identity.** `chunk_vectors.embed_model`
  scopes every comparison, so a model switch degrades to lexical-only until
  backfill completes rather than silently comparing across vector spaces. `eil`
  gets this right.
- **384 dimensions is a deliberate trade.** Larger models are better and cost
  more storage and compute. At 20M chunks, 768 dimensions doubles the vector
  footprint to 64 GB. Revisit only with an eval result that justifies it.

---

## Consequences

**Accepted**
- Retrieval quality is bounded by a small local model rather than a frontier
  embedding model. Reranking recovers most of that gap where it matters.
- Embedding throughput is bounded by local CPU; the initial backfill is
  measured in days.
- A model upgrade is a full re-embed and a transient doubling of vector storage
  ([04](../04-ingestion-and-delta.md) §8).

**Preserved**
- The system works with no network beyond the source systems
- No data egress decision blocks delivery
- Deterministic vectors, reproducible index
- MaaS can be adopted incrementally, per capability, without redesign
