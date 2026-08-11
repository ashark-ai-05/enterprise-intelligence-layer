# 06 — Retrieval

The requirement is semantic **and** text search across sources. Those are two
different failure modes and the whole design is about covering each with the
other.

- Lexical fails on vocabulary mismatch: *"money keeps getting stuck when I send
  it"* does not match *"parked payments not alerting after retry exhaustion"*.
- Semantic fails on exact tokens: `PAY-981`, `NullPointerException`,
  `retryHandler`, `src/payments/scheduler.ts`. Embeddings smear identifiers into
  approximate neighbourhoods, which is the opposite of what an exact lookup needs.

Neither is a superset. Fusing them is not a hedge; it is the design.

---

## 1. Query routing

Before any arm runs, a **deterministic** classifier inspects the query. No LLM
— routing must be reproducible, and an LLM adds latency and nondeterminism to
every request for a decision that regexes make correctly.

| Signal | Example | Effect |
|---|---|---|
| Ticket key | `PAY-981` | Direct lookup first; return immediately on hit |
| File path | `src/payments/retry.ts` | Code arm boosted, path-suffix matching on |
| Quoted phrase | `"retry budget"` | Strict arm only; phrase semantics preserved |
| Identifier shape | `retryHandler`, `MAX_ATTEMPTS` | Code arm boosted, sub-token expansion on |
| Error string | `NullPointerException at ...` | Strict lexical dominant; semantic de-weighted |
| Field filter | `source:code`, `space:ENG`, `after:2025-01` | Applied as predicates, removed from query text |
| Natural language | *"why do payments get stuck"* | All arms, semantic weighted up |

`eil` has a router already; the change is making the routing decision an
explicit, logged output so eval can attribute a failure to routing rather than
to ranking. A misrouted query and a badly ranked query need different fixes and
look identical in aggregate metrics.

---

## 2. Five arms

Each arm returns a ranked list of `(doc_id, chunk_seq, rank)`. Each arm applies
the ACL predicate **inside its own SQL** — composed from one builder, so an arm
added next year cannot forget it, and a bug fails closed.

| # | Arm | Index | Catches |
|---|---|---|---|
| 1 | **Lexical strict** | `tsv` GIN, `websearch_to_tsquery` | Exact phrases, all-terms-present |
| 2 | **Lexical loose** | `tsv` GIN, OR-ed stems | Partial matches, vocabulary variants |
| 3 | **Code lexical** | `tsv_code` GIN, `simple` config | Identifiers, paths, sub-tokens |
| 4 | **Semantic** | IVF funnel over `sig` → exact rescore | Paraphrase, concept, vocabulary mismatch |
| 5 | **Graph expansion** | `links` | Neighbours of strong hits: the runbook linked from the incident |

Arm 5 is cheap and disproportionately useful: the document that answers a
question is frequently one hop from the document that matches it. It must
re-apply the ACL predicate to the destination — traversing from a visible
document to a restricted one is the classic graph disclosure bug.

### The BM25 gap

`ts_rank` has neither IDF nor term-frequency saturation, so `work` counts as
much as `backoff`. This is the largest single ranking defect available in
Postgres full-text search, and `eil` has correctly built the apparatus for real
BM25 (`lexeme_stats`, `corpus_stats`, `chunks.len`) without switching to it,
because changing ranking without an eval gate is how you regress silently.

**Sequence: build the eval harness, then turn on BM25, then measure.** Not the
other way around. → [09](09-evaluation.md)

Document frequency is refreshed on a schedule rather than transactionally.
Staleness costs a little ranking accuracy and never correctness; maintaining
`df` per write would serialise ingestion on one hot row per lexeme.

---

## 3. The semantic arm, concretely

Exact `float4[]` dot product over 20M chunks is a linear scan — `eil` measured
298.5 µs/chunk on PGlite, which is hours at target scale. The funnel:

```
1. container pre-filter      → 1-5% of corpus survives          [ADR-0007]
2. IVF probe: nearest nprobe centroids of nlist                 [calibrated]
3. Hamming distance over `sig` (varbit XOR)  ~1.30 µs/chunk     (measured)
4. exact float4[] dot product over survivors — MANDATORY
5. best chunk per document, top-N cut, all in SQL
```

Two measured facts from `eil`'s calibration that should not be re-litigated:

- **Binary quantisation alone is not safe at 384 dimensions**: 63.5% recall@10.
  The frequently quoted ~95% retention figure applies to 1024+ dimensions.
  Shipping binary-only would be a silent 36-point regression. **Step 4 is not
  optional.**
- With exact rescore, **oversampling buys nothing** — 8× and 16× measured
  identical at every `nprobe`. All remaining loss is clusters not probed.
  Therefore `nprobe` is the knob, oversample is fixed.

`nprobe` is calibrated against a recall gate and re-measured when the corpus
doubles, with the calibration curve persisted so the chosen value is auditable
rather than folklore. This is a genuinely good piece of engineering in `eil` and
is adopted unchanged.

**If pgvector becomes available** on the provisioned Postgres, HNSW is strictly
better and the migration is additive — the funnel stays as the fallback for
deployments without it. Do not block on it.
→ [ADR-0002](adr/0002-one-postgres-no-mandatory-extensions.md)

---

## 4. Fusion

**Reciprocal rank fusion**, not score blending:

```
score(d) = Σ_arms  w_arm / (k + rank_arm(d))        k = 60
```

Scores from `ts_rank`, cosine similarity and graph proximity are not on a
common scale, and normalising them requires per-corpus calibration that goes
stale. Ranks are comparable by construction. RRF is the correct default and it
is what `eil` uses.

Arm weights are configuration, defaulted equal, tuned only against the eval
harness — never by intuition after looking at three queries.

### Post-fusion modifiers

Multiplicative, applied after fusion, each defensible independently:

| Modifier | Effect | Rationale |
|---|---|---|
| Quality tier | curated 1.3 → raw 0.8 | A reviewed runbook outranks a scratch page |
| Recency | Gentle decay over ~2 years | Newer is usually righter; the decay must be gentle or stable reference docs sink |
| Container authority | Boost from usage signal | Spaces people actually open |
| Link in-degree | Mild boost, capped | Heavily referenced pages are load-bearing |
| Chunk kind | `state` boosted for status-shaped queries | The synthesized Jira state chunk |

**Temporal validity is a filter, not a modifier.** Superseded documents are
excluded in the same predicate as ACL and tombstones, not down-weighted. A rank
penalty is a suggestion: a superseded page that is a strong lexical match still
surfaces, and *"the retry limit is 3"* from a replaced policy is not a slightly
worse answer, it is a wrong one. `eil` makes this call and the reasoning holds.

---

## 5. Reranking

The largest available quality gain, and the one place a model earns its cost.
A cross-encoder scoring `(query, chunk)` jointly beats bi-encoder similarity
substantially — typically 10–20 points of nDCG on realistic sets.

Constraints:

- **Off by default**, opt-in per call. It adds 150–400 ms and it is the only
  nondeterministic component; both must be a caller's explicit choice.
- **Top 50 → top 10.** Reranking more is latency for nothing.
- **Local ONNX cross-encoder preferred** (`bge-reranker-base`, ~280 MB,
  vendorable). Keeps determinism, avoids egress, no dependency on a beta
  endpoint.
- **MaaS as an alternative**, behind a circuit breaker with a budget cap,
  degrading to unreranked results rather than failing the query.

**Do not rerank inside the MCP `search_docs` tool by default.** Agents call
search speculatively and often; paying rerank cost on every speculative call is
the fastest way to make the platform feel slow and expensive.

---

## 6. Two-phase serving

`search_docs` returns ids and snippets. `get_doc` returns content for what the
consumer decided to open. This is `eil`'s design and it is right — its own
measurement puts a full-payload response at ~17,000 characters against ~7,400
for search-then-fetch, a 2.3× reduction on the same answer.

The right snippet size is a real trade-off. Too small and the agent fetches
everything, losing the benefit; too large and you have re-invented the full
payload. `eil` landed on ~90 words across two fragments, citing Provence
(ICLR 2025) on query-biased extraction holding answer quality while removing
50–80% of context. Two fragments rather than one because evidence is frequently
split within a document.

**The metric that tunes this is fetch-through** — the fraction of returned
results the consumer could not act on from the snippet alone. Not the
search-to-fetch call ratio, which saturates.

---

## 7. Latency budget

Target **p95 < 300 ms** for `search_docs` without rerank. A budget nobody wrote
down is a budget nobody meets.

| Stage | Budget | Notes |
|---|---|---|
| Auth + principal expansion | 10 ms | Cached, 5 min TTL |
| Container expansion | 5 ms | Cached |
| Query routing | 1 ms | Regex |
| Lexical arms (1–3, parallel) | 40 ms | GIN scans |
| Semantic arm | 90 ms | Container filter → IVF → Hamming → rescore |
| Graph expansion | 15 ms | Indexed lookup on top hits |
| Fusion + modifiers | 5 ms | In memory |
| **Snippet generation** | **60 ms** | `ts_headline`, **top 10 only** |
| Serialisation + audit | 15 ms | Audit write is async |
| Headroom | 59 ms | |

The snippet line is the trap. `ts_headline` is expensive and the naive
implementation generates it for every candidate. Generating for 500 candidates
instead of 10 turns a 60 ms stage into a 3-second one, and it is an easy mistake
because it is correct-looking code.

Optional rerank: +150–400 ms, quoted separately so nobody is surprised.

---

## 8. Determinism

Same query, same corpus, same order — every time. This is not aesthetic:

- **Evaluation** is impossible against a moving target.
- **Caching** is unsound if identical inputs can produce different outputs.
- **Debugging** a complaint requires reproducing the result the user saw.
- **Trust** — a system that returns different answers to the same question
  teaches people not to rely on it.

Concretely: no `now()` in ranking (recency decays against stored timestamps, and
validity is stamped at ingest so two identical queries cannot disagree because a
clock ticked); no random tie-breaking (ties break on document id); no model in
the default path.

Reranking is the one exception and is therefore opt-in and logged.

---

## 9. Where retrieval will actually be weak

Stated up front so it is measured rather than discovered.

1. **Multi-hop questions.** *"Which services are affected by the retry policy
   change in PAY-981?"* needs traversal and synthesis. Retrieval returns the
   pieces; assembling them is the consuming agent's job. Do not pretend
   otherwise by bolting an LLM into the retrieval path.
2. **Aggregation.** *"How many incidents mentioned retries last quarter?"* is a
   SQL question, not a search question. Serve it from the reporting views
   ([08](08-serving-and-front-doors.md)), not from ranked retrieval.
3. **Negation.** *"payments not using the retry helper"* — neither lexical nor
   semantic search represents absence. Route to code search with structural
   queries, or decline.
4. **Freshness-critical questions.** *"Is PAY-981 done?"* The index is a cache.
   Escalate to the live MCP tool.
   → [ADR-0008](adr/0008-mcp-tools-are-escalation-not-ingestion.md)
5. **Very long documents.** Best-chunk-per-document ranking under-serves a
   200-page specification where relevance is diffuse. Mitigate by aggregating
   the top-3 chunks per document rather than only the best.
