# 07 — Scale and capacity

"Scalable and fast" is not a design input until it has numbers attached. This
document attaches them, shows the arithmetic, and marks what is measured versus
what is estimated.

---

## 1. The workload is not what people assume

| Dimension | Value | Consequence |
|---|---|---|
| Corpus | ~2M documents, ~20M chunks | Large, but a single Postgres node's problem |
| Users | 500 – 5,000 | |
| Queries | ~5/user/day → **~25k/day peak** | **≈ 0.3 queries/second average**, single-digit QPS at peak |
| Ingest | ~50k changed items/day | ~0.6 writes/second sustained |
| Read:write | Heavily read-biased | Replicas work; caching is effective |

**This is a latency problem, not a throughput problem.** Single-digit QPS
against 20M chunks means the correct investments are index design, query
planning and cache locality — not horizontal scale-out, sharding, or a message
broker. Anyone proposing Kafka for 0.6 writes/second should be asked what
measurement motivated it.

The failure mode this workload actually produces is a **cold cache**: at 0.3
QPS, gaps between queries are long enough that a poorly-sized `shared_buffers`
means many queries pay disk latency. Sizing the working set to stay resident
matters more than anything to do with concurrency.

---

## 2. Storage

From [03](03-data-model.md) §7: **~105 GB** at target. **(estimated)**

The distribution is the interesting part:

```
embeddings   32 GB  ████████████████████████████████
chunk text   24 GB  ████████████████████████
headroom     25 GB  █████████████████████████
documents    10 GB  ██████████
tsv GIN       8.5GB ████████
other         5.5GB █████
```

Embeddings dominate. Three consequences, all already in the design:

1. Vectors live in `chunk_vectors`, not on `chunks` — so the chunk table stays
   narrow enough to be cache-resident.
2. The 1.1 GB `sig` column is what the funnel actually scans; the 32 GB of
   `float4[]` is touched only for the few thousand survivors of a rescore.
3. A model change transiently doubles vector storage. Budget +32 GB and plan the
   cutover ([04](04-ingestion-and-delta.md) §8).

**Working set** — what must stay in `shared_buffers` for the p95 target: chunk
text for hot containers, both GIN indexes, `sig`, `documents` hot columns.
Roughly **24–32 GB**. A machine with 64 GB RAM holds it comfortably; 128 GB
gives room to grow. This, not CPU, is the sizing constraint.

---

## 3. Postgres configuration that actually matters

| Setting | Value | Why |
|---|---|---|
| `shared_buffers` | 25–40% of RAM (16–24 GB) | Hold the working set; the single highest-leverage setting |
| `effective_cache_size` | ~75% of RAM | Planner chooses index scans over seq scans |
| `work_mem` | 64–128 MB | GIN bitmap scans and large sorts spill to disk otherwise; set per-session for search, not globally |
| `maintenance_work_mem` | 2 GB | GIN index builds during backfill |
| `random_page_cost` | 1.1 | SSD; the 4.0 default lies about modern storage and pushes the planner to seq scans |
| `max_parallel_workers_per_gather` | 4 | Vector rescore parallelises well |
| `default_statistics_target` | 500 on `container` | Skewed distribution; bad estimates here pick the wrong plan for the container pre-filter |
| Autovacuum on `chunks` | Aggressive | Re-chunking churns dead tuples; GIN bloat degrades quietly |

Partitioning by `tenant` (LIST) keeps per-partition indexes smaller and makes
dropping a tenant a `DROP TABLE`. Sub-partitioning `chunks` by `source` is
worth it only if one source dominates — measure before adding the complexity.

---

## 4. The vector funnel, with the arithmetic

At 20M chunks, per query, **(measured)** figures from `eil`'s calibration:

| Strategy | Per-chunk | Chunks scanned | Total |
|---|---|---|---|
| Exact `float4[]` dot product | 298.5 µs | 20,000,000 | **~1.7 hours** |
| Hamming over `sig` | 1.30 µs | 20,000,000 | ~26 s |
| Container pre-filter (3%) + Hamming | 1.30 µs | 600,000 | ~0.8 s |
| + IVF probe (`nprobe/nlist` ≈ 5%) | 1.30 µs | 30,000 | **~39 ms** |
| + exact rescore of ~2,000 survivors | 298.5 µs | 2,000 | ~0.6 s ⚠ |

The last row is the one to notice. **The exact rescore, not the scan, becomes
the bottleneck** once the funnel works. Mitigations, in order:

1. Rescore fewer — 500 survivors, not 2,000. Recall cost is measurable; measure it.
2. Parallelise the rescore (`max_parallel_workers_per_gather`).
3. Rescore only the best chunk per document after a cheap per-document
   pre-aggregation on the Hamming score.

Realistic target after tuning: **~90 ms for the semantic arm**, matching the
budget in [06](06-retrieval.md) §7. This should be re-measured on the actual
provisioned Postgres before it is believed — `eil`'s figures are from PGlite,
and server Postgres on real hardware will differ, likely favourably.

**`nprobe` is not a constant.** It is the output of a calibration run against a
recall gate, persisted so the value is auditable, and re-measured when the
corpus doubles.

---

## 5. Ingestion capacity

Backfill of 2M documents:

| Stage | Rate | Time |
|---|---|---|
| Fetch (rate-limited by source) | ~50 docs/s | **~11 hours** |
| Normalise + chunk | ~500 docs/s | ~1 hour |
| Embed, local ONNX, batched | ~200 chunks/s/worker | 20M chunks ÷ 200 = **~28 hours/worker** |
| Index write | ~2,000 chunks/s | ~3 hours |

Embedding is the long pole. Four parallel workers bring it to ~7 hours; the
ceiling is CPU on the ingest host, not the database. **(estimated)**

Realistic plan: **initial backfill is a week of off-peak running**, done per
container so value arrives incrementally and a failure costs one scope rather
than the whole run. Do not design a big-bang backfill; design a resumable one
and let it take as long as it takes.

Steady state — 50k changed items/day — is roughly 0.6 items/second, which is
noise. **Ingestion capacity is a backfill problem, not an ongoing one.**

---

## 6. Scaling sequence

In order. Do not skip ahead; each step is cheaper than the next and most
deployments stop early.

1. **Tune one node.** `shared_buffers`, `work_mem`, statistics targets,
   autovacuum. Most "we need to scale" conclusions are an untuned node.
2. **Read replicas for serving.** Retrieval is read-only. The primary handles
   ingest; replicas handle queries. Linear on read capacity, no application
   change beyond routing. Note replication lag: a document ingested one second
   ago may not be on the replica — acceptable for search, so long as `get_doc`
   after a `refresh_doc` reads the primary.
3. **Partition pruning.** Tenant and source partitioning to keep indexes small.
4. **Separate the embedding workers.** CPU-bound and independent; scale them
   without touching the database.
5. **pgvector + HNSW** if the extension becomes available. Strictly better than
   the funnel; additive migration.
6. **Shard by tenant.** Only if genuinely multi-organisation. For a single large
   organisation this step should never be reached, and reaching for it early
   buys enormous complexity for nothing.

---

## 7. What breaks first, in order

Useful because it tells you what to instrument now.

| # | Breaks | Symptom | When | Fix |
|---|---|---|---|---|
| 1 | **Snippet generation** | p95 climbs with result count | Immediately, if implemented naively | Generate for the returned page only |
| 2 | **Cold cache** | Bimodal latency; fast when warm, slow after idle | 20 GB+ working set on a small instance | `shared_buffers`, more RAM |
| 3 | **Exact rescore** | Semantic arm dominates the budget | ~5M chunks | Fewer survivors, parallel scan |
| 4 | **GIN bloat** | Lexical arms degrade over weeks | Heavy re-chunking | Aggressive autovacuum, periodic REINDEX |
| 5 | **ACL expansion** | Slow first query per user | Deep group nesting | Cache expansion, 5 min TTL |
| 6 | **IVF drift** | Recall drops silently | Corpus doubles after centroid build | Recalibrate on a schedule; gate in CI |
| 7 | **Source rate limits** | Backfill stalls, source team complains | First full backfill | Agreed budget per source host |

Item 6 is the dangerous one because it is **silent**. Every other failure here
announces itself as latency or an error; recall degradation from stale centroids
shows up only as people quietly deciding the search is not very good. It is the
strongest argument for the evaluation harness → [09](09-evaluation.md).

---

## 8. The honest summary

At the stated scale, with the stated query volume, **this is a single-node
Postgres workload with read replicas**. The architecture supports more, but the
numbers do not currently demand it.

The genuine risks are cache residency, snippet cost, rescore cost and recall
drift — all local optimisations. The scale-out machinery that dominates
discussions of "enterprise platforms" is not the constraint here, and building
it first would spend the project's credibility budget on the wrong thing.
