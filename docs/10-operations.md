# 10 — Operations

---

## 1. Metrics live where the facts are

Metrics are SQL views over the audit log and catalog, not a dashboard's
interpretation of a metrics pipeline. `eil` makes this call and it is right for
two reasons: the definitions are versioned with the schema and reviewable in a
diff, and they can be independently recomputed in a test — which means the
metric can be *wrong* in a way someone notices.

```sql
CREATE SCHEMA metrics;

CREATE VIEW metrics.vw_freshness AS
SELECT source, scope, lane,
       now() - last_ok_at AS lag,
       last_error IS NOT NULL AS failing
FROM sync_cursors;

CREATE VIEW metrics.vw_zero_result AS
SELECT date_trunc('day', at)::date AS day,
       count(*) FILTER (WHERE result_count = 0)::numeric / nullif(count(*),0) AS zero_rate
FROM audit_log WHERE tool IN ('search_docs','search_code') GROUP BY 1;
```

---

## 2. What to alert on

Ordered by what actually wakes someone up. Everything else is a dashboard.

| Severity | Condition | Why |
|---|---|---|
| **Page** | ACL sync lag > 60 min on any scope | A stale permission is a disclosure |
| **Page** | Any document readable with an empty `acl_allow` | Fail-closed invariant broken |
| **Page** | Search p95 > 1 s for 10 min | The platform is effectively down |
| **Page** | Secret detector finds a `true_positive` in a *newly indexed* doc | Live credential exposure |
| Ticket | Content sync lag > 6 h on any scope | Stale but not dangerous |
| Ticket | Zero-result rate > 10% day over day | Corpus or ranking regression |
| Ticket | Vector recall sample < 0.90 | Silent IVF drift → recalibrate |
| Ticket | Job dead-letter count rising | Connector or source problem |
| Ticket | Embedding backlog > 24 h of work | Falling behind |
| Info | Unknown Confluence macro rate rising | Extraction quality drifting |

The first two are the ones that matter. Everything else is recoverable; a
permissions failure is not, because disclosure cannot be undone.

---

## 3. Data-trust auditing

A cache of organisational knowledge is useful only if you can show it is
faithful. `eil`'s two-axis audit is the right model and is adopted:

**Integrity** — structural invariants, cheap SQL, offline, CI-gated:

- No chunkless documents (present but unsearchable)
- No document with empty `acl_allow` and no tombstone (invisible *or* leaking,
  depending on which way the predicate was written — this invariant catches both)
- No chunk whose `content_hash` disagrees with its text
- No vector whose `embed_model` is not the current one, outside a migration
- No cursor stale beyond its lane's SLA
- No ACE referencing a principal not in `principals`

**Drift** — the only check internal consistency cannot give you. Sample N
documents, re-fetch live, compare hashes. Reports `drifted`, `gone` (a deletion
reconcile has not caught), and `skipped`. Silent sync bugs surface here and
nowhere else.

Run integrity in CI on every push; run drift nightly on a sample proportional to
sensitivity, not to volume.

---

## 4. Runbooks

### A source connector is failing
1. `vw_freshness` → which scopes, since when, what error.
2. Distinguish: auth (token expired / rotated), rate limit (429), source outage
   (5xx), or schema change (parse failure).
3. Auth → rotate. Rate limit → lower the scope's budget, do not retry harder.
   Outage → pause the scope and let the queue hold. Parse failure → the source
   changed a format; fix the normaliser, and expect it to have been silently
   producing bad documents for a while, so re-sync the affected window.
4. **The cursor is not advanced on failure**, so recovery is resumption, not
   backfill.

### Search is slow
1. Is it all queries or one shape? Audit log has per-query latency.
2. Cold cache after idle → `shared_buffers`. Bimodal latency is the signature.
3. One arm dominating → check the semantic arm first; a stale `nprobe` after
   corpus growth is the usual cause.
4. Snippet stage → confirm generation is limited to the returned page.
5. `EXPLAIN` a representative query; a sequential scan on `chunks` means the
   container pre-filter is not being applied or statistics are stale.

### A document should not have been visible
**Treat as an incident.**
1. Freeze: `quarantined_at` on the document — removes it from every arm.
2. `audit_log.doc_ids` → who saw it, when. This is why ids are recorded.
3. Root cause: ACL sync lag? A `meta_hash` miss on a re-parent? Group expansion
   cache serving a departed user? A missing predicate on a new arm?
4. Add the case to the red-team suite **before** fixing, so it fails first.
5. Full ACL reconcile of the affected scope.

### Recall has degraded
1. Golden set run vs baseline → is it real or perception?
2. Vector recall sample vs exact → IVF drift?
3. Corpus grown since last centroid build → rebuild and recalibrate.
4. Attribution table ([09](09-evaluation.md) §4) → not-ingested, not-retrieved,
   or ranked-low. Fix the right layer.

---

## 5. Change management on a shared database

Once Postgres is a provisioned org service, migrations are somebody else's
change window.

- Migrations are **forward-only, additive, and non-blocking**. No `ALTER TABLE`
  that rewrites a 20M-row table during business hours.
- New columns are nullable with defaults added separately from the column.
- Index builds are `CONCURRENTLY`, always.
- Every migration is reversible in *effect* (feature flag off) even when not
  reversible in *schema*.
- Backfills are jobs, not migrations. A migration that runs for six hours is an
  outage wearing a change ticket.

---

## 6. Cost

Worth tracking because "it is just Postgres" hides real spend.

| Item | Driver | Control |
|---|---|---|
| Database storage | Corpus × chunks × vectors | Retention, scope selection, [ADR-0010](adr/0010-what-not-to-index.md) |
| Database compute | Query volume, cache residency | RAM sizing beats CPU |
| Embedding compute | Chunks changed per day | Hash gate at chunk granularity |
| MaaS calls | Rerank opt-ins, offline enrichment | Budget cap per tenant per day, circuit breaker |
| Source API quota | Backfill and reconcile | Agreed budget per source host |

The number worth reporting to sponsors is the one `eil` already computes:
**context characters saved per query** versus handing whole documents to a
model. Its own measurement is 17,032 → 7,434 characters on an eight-match query.
That ratio, multiplied by query volume, is the business case in a form a
finance team recognises.
