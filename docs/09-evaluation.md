# 09 — Evaluation

Without this, every ranking change is a coin flip, every complaint is
unfalsifiable, and recall degradation is invisible until people quietly stop
using the system.

The `eil` prototype is candid that its golden query log is still empty. That is
the single most important gap in it — not because the ranking is bad, but
because nobody can prove it is good, which means nobody can safely change it.
The BM25 apparatus sitting built-but-unused is the visible symptom: the right
call, blocked on the missing gate.

---

## 1. The bootstrapping problem

You need labels to measure, and you have no users yet to generate them. Three
sources, in the order they become available.

### 1.1 Synthetic, from the corpus (week 1)

Sample documents stratified by source, container and quality tier. For each, use
an LLM — offline, one-off, via Amp or Copilot, which is exactly what those tools
are good for — to generate the questions that document answers.

```
document → "generate 3 questions this document uniquely answers,
            phrased as a colleague would ask, not as a summary"
       → (question, expected_doc_id) pairs
```

**Caveat that determines whether this works**: generated questions inherit the
document's vocabulary, so they over-reward lexical matching and flatter your
system. Mitigate by explicitly instructing paraphrase, and by treating synthetic
scores as a **regression detector** rather than an absolute quality measure.
Regression detection is what you actually need from CI.

Target: 300–500 pairs. A week of effort, and it unblocks every ranking change
that follows.

### 1.2 Hand-curated golden set (weeks 2–6)

50–100 real questions from real people, with the correct answer identified by a
human who knows the domain. Expensive per item and worth it — this is the set
you trust when synthetic and implicit signals disagree.

Recruit from pilot users by asking for questions they *failed* to answer with
existing tools. Those are the queries that matter, and they are the ones
synthetic generation never produces.

### 1.3 Implicit, from usage (ongoing)

Once real traffic exists, the audit log is a label factory:

| Signal | Interpretation | Caution |
|---|---|---|
| `get_doc` after `search_docs` | That result was worth opening | Position-biased |
| No fetch at all | Snippet sufficed, **or** nothing was relevant | Ambiguous — do not treat as negative |
| Query reformulated within 60 s | The first attempt failed | Strong negative signal |
| Zero results | A gap in corpus **or** in ranking | Distinguish by checking whether the answer exists |
| Same query, many users | High value; deserves a golden entry | The best source of curated cases |

Position bias is real and must be corrected for, or you will train the ranker to
agree with itself. Interleaving experiments are the standard fix and are
affordable at this scale.

---

## 2. Metrics

| Metric | Definition | Target | Why |
|---|---|---|---|
| **Recall@10** | Correct doc in top 10 | > 0.85 | If it is not in the top 10, nobody sees it |
| **MRR** | Mean reciprocal rank | > 0.60 | Rewards being right at position 1 |
| **nDCG@10** | Graded relevance, discounted | > 0.70 | Multi-relevant queries |
| **Zero-result rate** | Searches returning nothing | < 5% | Corpus gap or routing failure |
| **Fetch-through** | Fraction of results opened | Tuning signal | Snippet sufficiency ([06](06-retrieval.md) §6) |
| **p95 latency** | `search_docs`, no rerank | < 300 ms | [07](07-scale-and-capacity.md) |
| **Reformulation rate** | Requeries within 60 s | < 15% | Honest proxy for user-perceived failure |
| **Vector recall@10** | ANN vs exact, on a sample | > 0.95 | **Catches silent IVF drift** |

The last is the one nothing else catches. Every other metric here degrades
visibly; recall loss from stale centroids degrades silently. It must be measured
on a schedule and gated in CI, which is exactly what `eil`'s persisted
calibration curve is designed to support.

---

## 3. The regression gate

**No ranking change merges without an eval run.** This is the rule that makes
the whole subsystem worth building.

```
CI:
  1. Build index from a fixed corpus fixture
  2. Run the golden set through the current ranker
  3. Compare against the committed baseline
  4. FAIL if recall@10 drops > 2 points, or p95 rises > 20%
  5. On pass, write the new baseline and record the run
```

Ranking changes gated this way include: BM25 activation, arm weight changes,
modifier tuning, chunking changes, embedding model changes, and `nprobe`
recalibration. All of these are "small tweaks" that routinely regress recall by
double digits.

**Corollary, which is the practical unblocking move**: `eil` should not turn on
BM25 until this gate exists. Build the harness first. It is less interesting
work and it is the thing that lets every subsequent improvement ship with
confidence.

---

## 4. Failure attribution

An aggregate score tells you something regressed, not what. Categorise every
failure so the fix is targeted:

| Category | Diagnosis | Fix |
|---|---|---|
| **Not ingested** | Document absent from the catalog | Connector scope, not ranking |
| **Not chunked usefully** | Present, but the answer spans a chunk boundary | Chunking strategy |
| **Not retrieved** | Chunk exists, no arm surfaced it | Arm coverage, tokenisation |
| **Retrieved, ranked low** | Present at rank 40 | Ranking — the only true ranking failure |
| **ACL-filtered** | Correctly hidden | Not a bug; remove from the eval set |
| **Misrouted** | Wrong arm dominated | Router, not ranker |

The distinction between "not retrieved" and "ranked low" is the one people
collapse, and collapsing it sends effort to ranking when the problem is
tokenisation. `eil`'s own migration 0017 documents a perfect example:
`to_tsvector('english','retryHandler')` yields `retryhandl`, so `handler`
matched nothing. No amount of ranking work fixes that.

---

## 5. Operating cadence

| Cadence | Activity |
|---|---|
| Per commit | Golden set in CI; block on regression |
| Weekly | Zero-result and reformulation review → indexing backlog |
| Weekly | Vector recall sample vs exact |
| Monthly | Add 10–20 golden queries from real usage |
| Quarterly | Full recalibration: `nprobe`, arm weights, modifiers |
| On corpus doubling | Rebuild centroids, recalibrate, re-baseline |

---

## 6. What good looks like at each phase

| Phase | Golden set | Recall@10 | Notes |
|---|---|---|---|
| P0 personal | 50 synthetic | > 0.70 | Lexical only; establishes the harness |
| P1 semantic | 300 mixed | > 0.80 | Hybrid should beat lexical by 10–15 points |
| P2 platform | 500 + real | > 0.85 | ACL-filtered cases excluded from scoring |
| P3 scale | 800 + per-domain | > 0.85 sustained | Held while the corpus grows 10× |

Sustaining recall as the corpus grows is harder than reaching it on a small
corpus, and it is the real test.
