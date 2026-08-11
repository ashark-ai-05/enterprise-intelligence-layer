# ADR-0006 — Rank fusion over score blending; no model in the retrieval path

**Status**: Proposed · **Date**: 2026-08-11 · **Adopted from**: `eil`

---

## Context

The requirement is semantic **and** text search. Multiple retrieval arms must be
combined into one ranked list. Two questions: how to combine them, and whether a
model participates.

---

## Decision

**Reciprocal rank fusion across five arms. No LLM anywhere in the retrieval
path. Reranking is the sole exception, opt-in per call and logged.**

```
score(d) = Σ_arms  w_arm / (k + rank_arm(d))        k = 60
```

---

## Rationale

### Why rank fusion, not score blending

`ts_rank` values, cosine similarities and graph-proximity scores occupy
incompatible ranges with incompatible distributions. Normalising them requires
per-corpus calibration that goes stale as the corpus grows, and a
min-max normalisation is dominated by whichever arm happens to produce an
outlier on that query.

Ranks are comparable by construction. RRF needs no calibration, is robust to one
arm producing degenerate scores, and degrades gracefully when an arm returns
nothing — which is exactly what happens when the vector arm is unavailable
because nothing is embedded yet.

`k = 60` is the standard value from the original RRF work and is not worth
tuning before there is an eval harness to tune against.

### Why no model in the retrieval path

Four independent reasons, any one of which would be sufficient:

1. **Evaluation.** A nondeterministic ranker cannot be regression-tested. Every
   eval run would measure model variance as well as ranking change, and the
   signal-to-noise ratio makes the gate useless — which means no ranking change
   can ever ship with confidence ([09](../09-evaluation.md)).
2. **Latency.** A model call is 200 ms to several seconds. The budget for the
   entire search is 300 ms ([06](../06-retrieval.md) §7).
3. **Cost.** Retrieval is the highest-frequency operation. Paying per token on
   every search inverts the economics the project exists to fix — the whole
   argument is that retrieval should be a query, not a completion.
4. **Availability.** The only server-side model access is a beta endpoint. A
   retrieval path that depends on it inherits its uptime
   ([ADR-0005](0005-local-first-embeddings.md)).

Determinism also buys sound caching and reproducible debugging: a user complaint
can be reproduced exactly, which is not true of any model-in-the-loop design.

### Where a model is still allowed

- **Offline**: golden query generation, supersession detection, duplicate
  clustering, synonym mining from query logs. No latency budget, no determinism
  requirement.
- **Reranking**: opt-in per call, top 50 → top 10, off by default. It is the
  largest single quality lever and it is correctly framed as a caller's explicit
  trade of latency for precision, not a default tax on every speculative agent
  search.

---

## Consequences

**Accepted**
- Arm weights are configuration and must be tuned against the eval harness, not
  intuition.
- RRF ignores score magnitude, so a spectacular match and a merely good one at
  the same rank contribute equally. In practice this is a feature: it prevents
  one arm's confidence from dominating.
- Without reranking, quality is bounded by the arms themselves. Acceptable, and
  measurable.

**Required**
- Every arm produces a rank, so every arm must sort deterministically. **Ties
  break on document id**, never on physical row order — otherwise identical
  queries can return different orders after a vacuum, which is the subtlest
  possible violation of the determinism guarantee.
- No `now()` in ranking. Recency decays against stored timestamps; validity is
  stamped at ingest. Two identical queries must not disagree because a clock
  ticked.
