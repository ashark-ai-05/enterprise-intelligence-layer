# 02 — Architecture

---

## 1. The shape in one paragraph

Source systems are polled by connectors that implement a single change-feed
contract. Changes become durable jobs. Workers normalise each item into one
canonical document, chunk it according to its type, and write it to Postgres
along with a lexical index, a semantic vector, a compact binary signature, link
edges and an access-control entry list. Retrieval runs five independent arms
over that index, fuses them by rank, filters by the caller's expanded principal
set, and returns identifiers with snippets. Consumers — MCP servers, web apps,
reports — fetch full content only for what they decided to open. No model runs
in the retrieval path.

---

## 2. Seven planes

Planes rather than layers, because they have different failure modes, different
scaling characteristics and different owners. A plane can be degraded without
taking down the others, and that property is the point.

```
┌──────────────────────────────────────────────────────────────────────┐
│  CONSUMER          MCP (stdio) · MCP (HTTP) · REST · BI / reporting  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  identity: OIDC → Viewer{principal, groups, tenant}
┌───────────────────────────────▼──────────────────────────────────────┐
│  SERVING           request auth · rate limit · tool dispatch · audit  │
└───────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────▼──────────────────────────────────────┐
│  RETRIEVAL         route → 5 arms → RRF → ACL gate → rerank? → snip   │
└───────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────▼──────────────────────────────────────┐
│  INDEX (Postgres)  documents · chunks · tsvector · float4[] · sig     │
│                    links · ACEs · principals · cursors · jobs · audit │
└───────────────▲───────────────────────────────▲──────────────────────┘
                │                               │
┌───────────────┴───────────────┐  ┌────────────┴─────────────────────┐
│  INGESTION                    │  │  GOVERNANCE                       │
│  normalise · chunk · enrich   │  │  ACL sync · secret quarantine     │
│  embed · link · idempotent    │  │  classification · retention · audit│
└───────────────▲───────────────┘  └───────────────────────────────────┘
                │
┌───────────────┴──────────────────────────────────────────────────────┐
│  CONNECTOR       Confluence · Jira · Bitbucket · Files · PDF · Grafana│
│                  one Source Feed Contract · proxy-aware HTTP · retry   │
└──────────────────────────────────────────────────────────────────────┘

              EVALUATION plane observes retrieval and gates changes
```

### 2.1 Connector plane
Talks to source systems. Owns pagination, rate limiting, retry, proxy dispatch
and credential handling. Emits raw items and ACL entries. Knows nothing about
chunking, embedding or ranking. Every connector implements the same contract
→ [ADR-0003](adr/0003-source-feed-contract.md), [04](04-ingestion-and-delta.md).

**Failure mode**: a source is down or throttling. Effect: that source's data
goes stale; everything else is unaffected; staleness is visible in metrics and
stamped on results.

### 2.2 Ingestion plane
Consumes jobs, produces index rows. Normalise → chunk → enrich → write, all
idempotent and resumable. Two lanes with separate priority: **backfill**
(bounded, off-peak, restartable) and **live delta** (small, frequent, latency
sensitive). A 2M-page backfill must not starve the five-minute delta.

**Failure mode**: a worker dies mid-document. Effect: none. The fenced job
lease expires, another worker reclaims it, and the write is idempotent on
`(tenant, doc_id, version)`.

### 2.3 Index plane
One Postgres. Catalog, chunks, both lexical indexes, vectors, signatures, link
graph, ACL graph, cursors, job queue and audit log — in the same transactional
store, because the alternative is reconciling two systems that disagree, and the
disagreement is always discovered by a user.
→ [ADR-0002](adr/0002-one-postgres-no-mandatory-extensions.md), [03](03-data-model.md).

**Failure mode**: primary unavailable. Effect: reads continue from replicas,
writes queue. This is the only plane whose loss is total, which is the argument
for it being the only stateful one.

### 2.4 Retrieval plane
Stateless and deterministic. Same query, same corpus, same order — because a
nondeterministic retrieval layer cannot be evaluated, cached or debugged.
→ [06](06-retrieval.md).

**Failure mode**: the vector arm is unavailable (no embeddings yet, model
mismatch). Effect: fusion proceeds with the lexical arms and results degrade
gracefully rather than erroring.

### 2.5 Serving plane
Stateless. Terminates identity, enforces rate limits, dispatches tools, writes
audit rows. **The only place a `Viewer` is constructed**, and it is constructed
from verified token claims, never from caller-supplied parameters.
→ [08](08-serving-and-front-doors.md).

### 2.6 Governance plane
ACL synchronisation, secret detection and quarantine, data classification,
retention and purge, and the audit trail. Runs on its own schedule with its own
SLA — tighter than content sync, because a stale permission is a disclosure and
a stale page is an inconvenience. → [05](05-acl-and-security.md).

### 2.7 Evaluation plane
Golden query sets, scored runs, regression gates in CI. Observes; does not
serve. Its output is permission to change ranking. → [09](09-evaluation.md).

---

## 3. Request paths

### 3.1 Search (the hot path)

```
client ──► serving: verify token → Viewer{principal, groups[], tenant}
              │
              ├─ expand principals: user + direct groups + nested groups   [cache, 5 min TTL]
              ├─ expand visible containers: spaces/projects/repos ∈ ACL    [cache, 5 min TTL]
              │
        retrieval: classify query  ──► ticket key? path? quoted phrase? error string?
              │
              ├── arm 1  lexical strict   (websearch_to_tsquery, phrase-aware)
              ├── arm 2  lexical loose    (OR-ed, stemmed)
              ├── arm 3  code lexical     (simple config, identifier-split)
              ├── arm 4  semantic         (container pre-filter → IVF probe → Hamming → exact rescore)
              └── arm 5  graph expansion  (link neighbours of arms 1-4 top hits)
              │
              ▼  each arm returns ranked doc ids, each arm already ACL-filtered in SQL
        reciprocal rank fusion  ──►  metadata modifiers (recency, tier, validity)
              │
              ├─ optional cross-encoder rerank of top 50 → top 10   [off by default]
              ▼
        snippet generation for the returned page only (never for candidates)
              │
              ▼
        audit row  ──►  { id, title, url, snippet, source, updated_at, staleness, score }
```

**Two properties worth defending.** First, the ACL predicate is composed into
*every* arm's SQL rather than applied afterwards — an arm added later cannot
forget it, and a bug fails closed. This is inherited directly from `eil` and it
is the right pattern. Second, snippets are generated only for the results
actually returned. `ts_headline` is expensive; generating it for 500 candidates
instead of 10 is the single easiest way to blow the latency budget.

### 3.2 Fetch

`get_doc(id, window)` → ACL re-check → windowed body. The ACL is re-evaluated
on fetch, not trusted from the search that produced the id. Search results are
not capability tokens.

### 3.3 Escalation to live

When a result's staleness exceeds the caller's tolerance, or the caller needs
current state (ticket status, build result, log lines), the consumer calls the
**existing live MCP tools** with the identifier the index supplied. The index
provides *findability*; the live tool provides *currency*.
→ [ADR-0008](adr/0008-mcp-tools-are-escalation-not-ingestion.md)

### 3.4 Ingest

```
scheduler ──► enqueue sync job per (source, scope)      idempotency: source:scope:window
    │
worker claims (FOR UPDATE SKIP LOCKED, fenced lease)
    │
    ├─ connector.listChanges(scope, cursor) ──► [{externalId, version, updatedAt}]
    ├─ for each: compare (content_hash, meta_hash) against catalog
    │     ├─ both match  ──► no-op, cheapest possible outcome
    │     ├─ meta only   ──► update metadata + ACL + hierarchy, keep chunks & vectors
    │     └─ content     ──► re-chunk, re-embed changed chunks only, rewrite
    ├─ advance cursor ONLY after the batch commits
    └─ emit link edges, ACEs, secret-scan findings
```

The `meta_hash` / `content_hash` split is what makes a page move cheap *and*
correct. Re-embedding a 400-chunk page because someone re-parented it is waste;
skipping it because the body did not change is a permission bug.
→ [ADR-0004](adr/0004-two-hash-change-detection.md)

---

## 4. Deployment modes

One codebase, one schema, two postures. The migration between them is a
configuration change plus a security review, not a rewrite — which is precisely
why it must be designed now rather than discovered later.

| | **Personal** | **Platform** |
|---|---|---|
| Who runs it | Each user, on their laptop | A service, centrally |
| Postgres | PGlite in `node_modules`, or local PG | Provisioned org Postgres + read replicas |
| Credentials | The user's own PATs | Service account, read-only |
| ACL model | Ingester-only. You indexed it, you can read it | Mirrored ACEs, deny-wins, directory-resolved groups |
| Identity | OS user | OIDC bearer, per-request `Viewer` |
| Transport | MCP stdio | MCP streamable-HTTP + REST |
| Corpus | What one person cares about | Organisational |
| Gate to enter | None | Security review, ACL red-team suite green, audit live |

**Personal mode is not a demo.** It is the phase-0 product and the adoption
strategy: it delivers value without a procurement cycle, and it generates the
query logs that make the platform-mode ranking defensible. It is also
approximately what `eil` is today.

The trap to avoid is letting personal mode's ACL rule ("the ingester can read
it") survive into platform mode, where a service account ingests everything and
that rule would make everything readable by everyone. The schema must make this
impossible rather than merely discouraged → [05](05-acl-and-security.md) §6.

---

## 5. What is deliberately absent

| Not present | Why |
|---|---|
| A message broker | Postgres `SKIP LOCKED` is a correct queue at this volume, and it is one fewer system to get approved. Revisit above ~10M jobs/day; we are three orders of magnitude below that |
| A separate vector database | Splitting vectors from the ACL and metadata they must be filtered by means either denormalising permissions into the vector store or two-phase queries that lose recall. → [ADR-0002](adr/0002-one-postgres-no-mandatory-extensions.md) |
| A cache tier | The corpus is read-mostly and Postgres' buffer cache is effective. Add only against a measured miss rate |
| An LLM in retrieval | Nondeterminism makes evaluation, caching and debugging impossible, and adds latency and cost to every query. → [ADR-0006](adr/0006-hybrid-retrieval-rrf.md) |
| A knowledge graph / entity resolution layer | High cost, speculative benefit, and it competes for the effort ACL correctness needs. The link graph gives most of the value for a fraction of the work. Revisit after phase 3 |
| Real-time streaming ingest | Sources do not emit reliable event streams. Five-minute polling is honest about what is achievable |

---

## 6. Cross-cutting invariants

These hold everywhere, and violations are bugs regardless of local
justification.

1. **Fail closed.** A document with no ACE is visible to nobody. A tenant
   mismatch returns nothing. An error in permission evaluation denies.
2. **Determinism in retrieval.** No clock, no random, no model. Ranking may
   depend on stored timestamps; it may not depend on `now()`.
3. **Idempotency in ingestion.** Every write is safe to repeat. Cursors advance
   only after the work they cover has committed.
4. **The `Viewer` is derived, never supplied.** No API accepts a principal,
   group list or tenant as a parameter.
5. **Every read is one audit row.** Principal, tool, arguments, result count.
   This is what makes a security review survivable.
6. **Staleness is data.** Every result carries when it was last synced. A
   consumer that cannot tolerate the staleness escalates to the live tool.
7. **Sources stay authoritative.** The index never becomes the place a fact
   lives.
