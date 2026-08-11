# 15 — Revised architecture, open questions, and delivery plan

Three things, in the order they are useful:

1. **The architecture as revised** by [14](14-prior-art-gaps-and-pre-build-changes.md) —
   eight planes, not seven, and three data-model changes.
2. **Open questions**, ranked, each with a recommendation so that *nothing is
   blocked by an unanswered question*. An open question without a default is a
   stalled project.
3. **Task breakdown** — epics, tasks, sizes, dependencies and the critical path.

The rule applied throughout: every question below has a recommended answer. If
you never reply to any of them, the plan still executes. Answers change the
plan; silence does not stop it.

---

## Part 1 — Revised architecture

Three structural changes from [02](02-architecture.md) and
[13](13-system-diagram-and-tech-stack.md), all consequences of the gap analysis:

| # | Change | Why |
|---|---|---|
| 1 | **New Identity plane** — authority resolvers + `principal_map`, distinct from Governance | Principals are per-authorization-domain. `P(user)` needs constructing, not assuming → Gap 1 |
| 2 | **ACLs by reference** — `container_aces` authoritative, `document_aces`/`chunk_aces` sparse overrides | One space-permission change must be one row, not 200k → Gap 2, Gap 3 |
| 3 | **Federated arm** — arm 6, live, source-enforced | Value in week one, and the only continuous ACL-mirroring oracle in the design → [14](14-prior-art-gaps-and-pre-build-changes.md) §3.3 |

```
 SOURCES  Confluence · Jira · Bitbucket · file shares · PDFs        [+ future]
 ════╤════════════════════════════════════════════════════════════════════════
     │ poll only (no inbound ingress) · undici ProxyAgent · rate-limited
 ┌───▼─────────────────────────────────────────────────────────────────────┐
 │ CONNECTOR — four interfaces, Onyx-style                                 │
 │   load()    bulk backfill, checkpointed and resumable                   │
 │   poll(t0,t1)  incremental by time window                               │
 │   slim()    IDs only  →  deletion by set difference, cheap              │
 │   authority(principal) →  tokens in THIS source's namespace   ◄── new   │
 └───┬─────────────────────────────────────────────────┬───────────────────┘
     │ content                                          │ principals + ACEs
 ┌───▼──────────────────────────────────┐  ┌────────────▼───────────────────┐
 │ INGESTION                            │  │ IDENTITY  ◄── new plane        │
 │  raw retain → normalise              │  │  principal_map                 │
 │  → THREE-HASH GATE                   │  │   (directory ⟷ per-domain id)  │
 │     content → re-chunk, re-embed     │  │  authority resolvers per source│
 │     meta    → keep chunks + vectors  │  │  group expansion, 5-min cache  │
 │     acl     → ACE update only        │  │  UNMAPPED ⇒ DENY               │
 │  → chunk → secrets → embed changed   │  │  coverage metric per source    │
 └───┬──────────────────────────────────┘  └────────────┬───────────────────┘
     │                                                   │
 ┌───▼───────────────────────────────────────────────────▼───────────────────┐
 │ INDEX — one PostgreSQL                                                    │
 │   documents · chunks · chunk_vectors · links · jobs · cursors · audit      │
 │                                                                           │
 │   ACL BY REFERENCE:                                                       │
 │     container_aces   authoritative, ONE row per (container, principal)    │
 │     document_aces    SPARSE — only where a doc overrides its container    │
 │     chunk_aces       SPARSE — only where a chunk overrides its doc        │
 │                      (Jira restricted comments live here)                 │
 │   visible ⟺ container ALLOW ∧ ¬container DENY                             │
 │             ∧ ¬doc DENY ∧ (doc ALLOW if any doc ACE exists)               │
 │             ∧ ¬chunk DENY ∧ (chunk ALLOW if any chunk ACE exists)         │
 └───┬───────────────────────────────────────────────────────────────────────┘
 ┌───▼───────────────────────────────────────────────────────────────────────┐
 │ RETRIEVAL — stateless · deterministic · no model in the path              │
 │   alias expansion (jargon dictionary)  ◄── new                            │
 │   classify ─┬ 1 lexical strict ┬                                          │
 │             ├ 2 lexical loose  │                                          │
 │             ├ 3 code lexical   ├→ RRF → modifiers → ACL gate              │
 │             ├ 4 semantic       │    → source-diversity cap → snippet      │
 │             ├ 5 graph expand   │                                          │
 │             └ 6 FEDERATED live ┘ ◄── new: source-enforced ACL, live       │
 │                                        also the ACL drift oracle          │
 └───┬───────────────────────────────────────────────────────────────────────┘
 ┌───▼───────────────────────────────────────────────────────────────────────┐
 │ SERVING — callTool(name, args, viewer, db), the only choke point          │
 │   OIDC → Viewer (derived) · rate limit · audit · provenance markers       │
 └─┬────────┬─────────┬──────────┬───────────┬───────────────────────────────┘
   MCP     MCP HTTP  REST /v1   Web SPA    BI (replica, aggregate-only)
   stdio

 GOVERNANCE  secrets · retention · purge · audit (query log is itself sensitive)
 EVALUATION  golden set from link-graph harvest + thumbs + zero-result log
```

### 1.1 Why the federated arm changes the shape, not just the roadmap

Arm 6 is the same interface as arms 1–5 and fuses identically, but it inverts
two properties: its ACL is **enforced by the source** rather than mirrored, and
its freshness is **live** rather than poll-interval. That makes it simultaneously
a product feature (week-one value) and a test fixture (diff arm 6 against arms
1–5; anything the index returns that federation does not is a mirroring bug).

The cost is honest and should be stated: it adds source latency to the hot path
and it is rate-limited by the source. Run it **on by default in phase 0, and
behind a per-query flag from phase 2** — by then the index should be better, and
federation's job becomes the nightly ACL drift check rather than a live arm.

---

## Part 2 — Open questions

### Tier 1 — Facts. Week one. Cheap to establish, and they invalidate plans.

None of these are judgement calls. Each is answerable in under a day, and each
can delete a phase.

| # | Question | Recommendation / default if unanswered | How to answer |
|---|---|---|---|
| **F1** | **Where can a long-lived process and a Postgres actually run?** | **Assume nowhere.** Build personal-mode-capable from day one — it costs nothing and it is the difference between a project and a proposal. Promote later | Ask whoever owns the internal app platform |
| **F2** | **Does the MaaS endpoint serve embeddings** — or only chat/completions? Dimensions, batch size, rate limit, data-retention and training terms? | Use it for **query-time** embeddings if it exists (one vector per query, latency-tolerant). Keep **bulk** embedding local regardless — see §2.4 | One curl. Sonnet offered to own this; it is the highest-leverage single fact in the thread |
| **F3** | **Does `npm install` resolve the whole tree through the internal mirror**, including transitive optional binary deps? | Trial with `--ignore-scripts`, then without. Commit the lockfile from the mirror | 30 minutes |
| **F4** | **Does a proxied request to Confluence / Jira / Bitbucket / MaaS succeed** with production-like auth? | `ProxyAgent` as global dispatcher, all four tested | 1 hour. Node's `fetch` ignores `HTTPS_PROXY` — see [ADR-0009](adr/0009-proxy-and-no-install-runtime.md) |
| **F5** | **Atlassian Cloud or Data Center?** | Changes everything downstream: rate limits, `accountId` vs username, webhook feasibility, whether bulk export APIs exist | Look at the URL |
| **F6** | **Actual corpus size** — pages, issues, repos, bytes, changes/day | Measure, do not estimate. Three API calls. Every capacity number in [07](07-scale-and-capacity.md) is a guess until this exists | 1 hour |
| **F7** | **Postgres: obtainable at all? Version? `pgvector` / `pg_trgm` available?** | Design assumes none → [ADR-0002](adr/0002-one-postgres-no-mandatory-extensions.md). If available, strictly better, no redesign | Ask the DBA |
| **F8** | **Is there an approved object store?** | Content-addressed files on disk until there is one. Not a blocker | Ask |
| **F9** | **Can you get a read-only service account** on Confluence/Jira, at what agreed rate limit? | Start this now — multi-week lead time, and it gates platform mode entirely | Ask the Atlassian admins |

**F2 deserves its own note**, because Sonnet is right that it is unresolved and
right that it is upstream of the stack. My recommendation is not
"whichever exists":

> **Bulk embedding should stay local even if the MaaS endpoint serves
> embeddings.** Pushing 20M chunks through it means transmitting the full text
> of every restricted Confluence page and every access-controlled Jira comment
> to an endpoint whose retention and training terms are, by its own
> description, *beta*. That is a data-governance event, and it will be the first
> question asked in a security review. Local ONNX means content never leaves the
> process. Query-time embedding is a different matter — one short string, no
> corpus egress — and MaaS is a fine fit there.

That argument holds regardless of what F2 returns, which is why local-first
survives as the recommendation.

### Tier 2 — Decisions only you or the org can make.

| # | Question | Recommendation |
|---|---|---|
| **D1** | Single index for the whole company, or separate business units / acquired subsidiaries / data-residency boundaries? | **Assume single.** Keep the `tenant` column (free, unremovable later), delete the isolation machinery. If a second instance exists, say so now — it is a day-one schema decision |
| **D2** | Personal mode first, or platform mode first? | **Personal first, decisively.** It ships in weeks with zero approvals, generates the query logs that make platform ranking defensible, and is a working product if platform never gets funded |
| **D3** | Which Confluence space, Jira project and repos for the pilot? | **The ones you personally answer questions out of.** Not the biggest, not the tidiest. You are the only person who can evaluate result quality on day one, and you can only do that on a corpus you know |
| **D4** | Is a works council consultation / DPIA required? | **Ask this week**, in parallel with engineering. It does not gate infra work; it gates which spaces enter the pilot corpus. Finding out mid-build is the bad outcome |
| **D5** | Reporting ACL posture — aggregate-only, per-audience materialised views, or an audited role? | **Aggregate-only, no drill-through.** Counts are not disclosure; document lists are. Simplest defensible answer → [08](08-serving-and-front-doors.md) §3.4 |
| **D6** | Who operates this when you are on leave? | If the honest answer is "nobody", that is not a criticism — it is a **cap**, and it means personal mode is the product and platform mode should not be scheduled |
| **D7** | Is publishing the design repo publicly acceptable? | Currently **private**. It describes internal architecture; that is your call, not mine |

### Tier 3 — Technical decisions. We should give one answer, not three.

Sonnet correctly flagged that the three of us produced conflicting defaults.
Resolved below, with reasoning.

| # | Question | Decision | Reasoning |
|---|---|---|---|
| **T1** | Embedding path | **Local ONNX for bulk; MaaS for query-time if F2 allows; WASM runtime fallback** | Corpus egress argument above. The `Embedder` interface makes this swappable either way |
| **T2** | Web framework — Next.js vs SPA | **React + Vite SPA, static bundle served by the API process** | It is a search box, filters and a result list. SSR buys nothing internally, and it removes a hosting decision. Lowest-stakes disagreement in the thread; picking one matters more than which |
| **T3** | Zoekt | **"Pending approval" slot only. Never a pilot default** | Agreeing with Sonnet against Codex's placement. It is a Go binary; the constraint forbids it until someone confirms otherwise |
| **T4** | BM25 | **`ts_rank_cd` until the eval harness exists, then hand-built BM25, then `pg_search` if an extension is ever approved** | Ranking changes without measurement are coin flips. Sequence matters more than the endpoint |
| **T5** | Confluence body format | **`body.storage` + explicit macro-handling table + unknown-macro metric** | `export_view` makes Confluence execute macros at crawl rate and makes `content_hash` reflect transcluded content |
| **T6** | Semantic code arm | **Deferred to phase 4.** Trigram + symbols first | A prose model on code is worse than identifier search for most real queries |
| **T7** | "Request access" affordance | **Yes — at container granularity only. Never at document granularity** | This needs care: revealing *"a document you cannot see matched"* leaks its existence, and often its title, which is frequently the sensitive part ("Project Falcon redundancies Q3"). Revealing *"there are 3 spaces you cannot search"* leaks almost nothing and is what makes the affordance useful. **Container-level request-access, document-level silence.** Adopting Sonnet's gap with that boundary |
| **T8** | Staleness / authority in ranking | **Yes — already in [06](06-retrieval.md) modifiers.** Owner-attested freshness deferred to phase 3 | Agreeing with Sonnet that it is essential; noting it is designed, not missing |
| **T9** | Query audit log privacy | **Separate retention, separate access grant, shorter TTL than content audit** | Adopting Sonnet's gap wholesale. Someone searching HR or legal terms is itself sensitive, independent of what matched. Genuinely absent from my design |
| **T10** | Thumbs up/down feedback | **Same feature as the golden set and the zero-result log. Build once, in phase 1** | Adopting Sonnet's point — I had these as three separate ideas and they are one |
| **T11** | Index-generation atomicity | **Adopt a reduced form**: publication gated on catalog + ACL agreeing. Full multi-index manifest deferred until a second physical index exists | Codex is right that a stale-ACL-generation read is a real hazard. With one Postgres and transactional writes the reduced form is sufficient; the full manifest is essential the moment code search moves to a separate engine |

---

## Part 3 — Task breakdown

Sizes: **S** ≤ 1 day · **M** 2–4 days · **L** 1–2 weeks. One engineer.
Dependencies are hard unless marked *soft*.

### P0 — Facts and federated value · 11 tasks, ~17 engineer-days

Zero infrastructure. Zero approvals. Ships something usable.

| ID | Task | Size | Depends |
|---|---|---|---|
| P0-1 | Run the 9-item constraint checklist ([ADR-0009](adr/0009-proxy-and-no-install-runtime.md)); record each as fact + evidence | M | — |
| P0-2 | MaaS capability probe: embeddings? dims? batch? rate limit? retention terms? (F2) | S | — |
| P0-3 | Corpus census: pages, issues, repos, bytes, changes/day (F6) | S | P0-1 |
| P0-4 | Repo scaffold: pnpm workspaces, TS, vitest, `.npmrc` → internal mirror | S | P0-1 |
| P0-5 | `ProxyAgent` global dispatcher + `NO_PROXY` + `NODE_EXTRA_CA_CERTS`; smoke test all four hosts | S | P0-4 |
| P0-6 | Federated search: Confluence CQL + Jira JQL clients | M | P0-5 |
| P0-7 | RRF fusion module (pure, unit-tested — reused by every later arm) | S | P0-4 |
| P0-8 | MCP stdio server exposing `search_enterprise` | M | P0-6, P0-7 |
| P0-9 | Query + result + zero-result logging to a local file | S | P0-8 |
| P0-10 | Wire into Amp and Copilot; use it yourself for a week | S | P0-8 |
| P0-11 | Start the D4 (works council) and F9 (service account) conversations | S | — |

**Exit gate:** you and 2–3 colleagues use it unprompted; ≥100 real queries
logged; every Tier-1 fact recorded with evidence.

### P1 — Catalog, one source, lexical, ACL-correct · 19 tasks, ~74 engineer-days

| ID | Task | Size | Depends |
|---|---|---|---|
| P1-1 | Schema v1 + SQL migration runner | M | P0 gate |
| P1-2 | `container_aces` / `document_aces` / `chunk_aces` **by-reference** model + visibility function | L | P1-1 |
| P1-3 | `principal_map` + `(authorization_domain, identifier)` principals; **unmapped ⇒ DENY** | L | P1-1 |
| P1-4 | Directory group expansion + 5-min cache | M | P1-3 |
| P1-5 | Confluence authority resolver (space perms, restriction chains, ancestor walk) | L | P1-3 |
| P1-6 | Job queue: `SKIP LOCKED` + fenced leases + backoff + DLQ | M | P1-1 |
| P1-7 | Connector interface: `load` / `poll` / `slim` / `authority`, with checkpointing | M | P1-6 |
| P1-8 | Confluence connector — content, `body.storage`, macro table | L | P1-7, P1-5 |
| P1-9 | Heading-aware prose chunker | M | P1-8 |
| P1-10 | Lexical arms 1–2 (`tsvector` + GIN), ACL predicate composed **into the SQL** | M | P1-2, P1-9 |
| P1-11 | Snippet generation — returned page only, never candidates | S | P1-10 |
| P1-12 | `callTool` dispatch + audit row per read + `search_docs`/`get_doc` | M | P1-10 |
| P1-13 | **ACL red-team suite** — restricted page, re-parent, restricted comment, group removal, unmapped principal, deleted user | L | P1-2, P1-3 |
| P1-14 | Link-graph label harvest → first golden set | M | P1-8 |
| P1-15 | Eval harness + recall@10 / p95 report | M | P1-14 |
| P1-16 | Thumbs up/down + zero-result capture, feeding P1-14 | S | P1-12 |
| P1-17 | Alias dictionary from space/project/repo names + query expansion | M | P1-8 |
| P1-18 | Secret scanning before anything becomes searchable | M | P1-8 |
| P1-19 | Query-audit privacy: separate retention + restricted grant | S | P1-12 |

**Exit gate:** red-team suite green; recall@10 > 0.70; federated-vs-indexed
diff shows zero unexplained index-only results.

### P2 — Delta, deletion, second and third sources · 14 tasks, ~62 engineer-days

| ID | Task | Size | Depends |
|---|---|---|---|
| P2-1 | Three-hash gate: content / meta / ACL, three outcomes | L | P1 gate |
| P2-2 | Cursor discipline — advance only after batch commit; overlap window | M | P2-1 |
| P2-3 | `slim()` reconciliation sweep → deletion by set difference | M | P2-1 |
| P2-4 | Tombstones + purge + retention matrix | M | P2-3 |
| P2-5 | User-centric permission sync + staleness scheduler + rate-limited queue | L | P1-3 |
| P2-6 | Jira connector + authority (permission scheme → **roles** → members; issue security levels) | L | P1-7 |
| P2-7 | Jira comment-level ACEs into `chunk_aces` | M | P2-6, P1-2 |
| P2-8 | Jira thread-aware chunker | M | P2-6 |
| P2-9 | File-share / PDF connector (`pdfjs-dist`, `mammoth`, `exceljs`) + quarantine path | L | P1-7 |
| P2-10 | Link extraction: issue keys in commits, Confluence links, page→attachment | M | P2-6 |
| P2-11 | Graph expansion arm (arm 5) | M | P2-10 |
| P2-12 | Source-diversity cap in fusion | S | P1-10 |
| P2-13 | Operator surface: freshness, coverage, lag, DLQ, quarantine, pause/kill, `doctor` | L | P2-2 |
| P2-14 | Federation demoted to flag + **nightly ACL drift job** | M | P2-5 |

**Exit gate:** `fetched/seen` < 0.1 steady state; a page re-parent updates ACEs
without re-embedding, proven by test; deletion propagates within one sweep;
nightly drift job reports zero.

### P3 — Semantic and measurable · 10 tasks, ~44 engineer-days

| ID | Task | Size | Depends |
|---|---|---|---|
| P3-1 | `Embedder` interface + local ONNX impl + WASM fallback | L | P2 gate |
| P3-2 | MaaS `Embedder` impl for query-time (if F2 allows) | M | P3-1, P0-2 |
| P3-3 | Vector storage, model-id stamped per vector | M | P3-1 |
| P3-4 | Vector funnel: signatures → IVF probe → Hamming → **exact rescore** | L | P3-3 |
| P3-5 | Backfill lane, checkpointed, off-peak, restartable | M | P3-4 |
| P3-6 | Semantic arm (arm 4) with container pre-filter first | M | P3-4 |
| P3-7 | Golden set to 300 pairs; CI regression gate | M | P1-15 |
| P3-8 | Hand-built BM25 (`lexeme_stats`, `corpus_stats`, `len`) — **after** P3-7 | L | P3-7 |
| P3-9 | Recency / tier / validity modifiers; owner-attested freshness | M | P3-7 |
| P3-10 | Index aliasing for embedding-model migration | M | P3-3 |

**Exit gate:** hybrid beats lexical-only by ≥10 points recall@10; vector recall
vs exact > 0.95; p95 < 300 ms; CI blocks a deliberately-introduced regression.

### P4 — Code · 10 tasks, ~42 engineer-days

| ID | Task | Size | Depends |
|---|---|---|---|
| P4-1 | Bare-mirror git sync; per-repo cursor = last indexed SHA | M | P3 gate |
| P4-2 | Tree-diff delta; force-push / non-ancestor reconcile | M | P4-1 |
| P4-3 | Blob-SHA content addressing + `(repo,path,commit)→blob` pointer table | M | P4-1 |
| P4-4 | Exclusion policy: vendor, generated, minified, LFS, huge files — per-repo overridable | S | P4-1 |
| P4-5 | `web-tree-sitter` symbol chunker | L | P4-3 |
| P4-6 | Code lexical arm — identifier-aware tokenizer, `pg_trgm` if available | L | P4-5 |
| P4-7 | Symbol/reference index; SCIP/LSIF ingest where CI emits it | L | P4-5 |
| P4-8 | Repo-level ACL (container-first, same machinery as spaces) | M | P1-2 |
| P4-9 | `search_code` / `get_code` — citations pinned to exact commit SHA | M | P4-6 |
| P4-10 | Query router: identifier / path / regex / natural language | M | P4-6, P4-7 |

**Exit gate:** exact identifier search beats grep-on-checkout on latency;
citations resolve to the indexed commit, not HEAD.

### P5 — Platform mode · 7 tasks, ~26 engineer-days · gated on F1, D2, D6, not on a date

| ID | Task | Size |
|---|---|---|
| P5-1 | OIDC bearer + `jose` JWKS; **remove the local-viewer constructor from the code path** | M |
| P5-2 | MCP streamable-HTTP + REST `/v1` adapters over the same `callTool` | M |
| P5-3 | React + Vite SPA served by the API process | L |
| P5-4 | Read replicas + `rpt.*` views, aggregate-only | M |
| P5-5 | Per-principal rate limits, timeouts, pool sizing | M |
| P5-6 | Injection posture: provenance markers, ingest-time flagging, no-write-loop rule | M |
| P5-7 | Security review + ACL red-team green as the entry gate | — |

### 3.1 Critical path

```
P0-1 facts ─► P0-5 proxy ─► P0-6 federated ─► P0-8 MCP ──► [P0 gate]
                                                             │
       ┌─────────────────────────────────────────────────────┘
       ▼
 P1-1 schema ─► P1-2 ACL-by-reference ─► P1-3 principal_map ─► P1-5 authority
                        │                        │
                        └────────► P1-13 red-team suite ◄────┘
                                        │
                                   [P1 gate]  ◄── the real gate; everything
                                        │           downstream assumes it
                        P2-1 three-hash gate ─► P2-5 user-centric sync
                                        │
                                   [P2 gate] ─► P3 semantic ─► P4 code ─► P5
```

**P1-2 and P1-3 are the critical path.** They are unglamorous, they produce no
demo, and everything after them is either correct or leaking because of them.
Resist the pull to do P3 semantic search early because it is the interesting
part — a semantic arm over a broken ACL model is a faster way to disclose
things.

### 3.2 Sequencing rules

1. **Nothing ships to a second user until the red-team suite is green.**
2. **No ranking change before the eval harness exists** — including BM25.
3. **Every connector passes the same certification** before it counts: stable
   IDs, monotonic cursor, deletion detection, independent ACL retrieval, replay
   idempotency, proxy behaviour. (Codex's connector contract, adopted.)
4. **Federation stays running** as the ACL oracle long after it stops being a
   live arm.
5. **Cut scope, never gates.** If time runs short, drop a source, drop the web
   app, drop the semantic arm. Do not drop the red-team suite or the eval gate.

---

## Part 4 — What I would do on Monday

1. Run P0-1 through P0-3. Half a day. Every number in every document above is a
   guess until then.
2. Send two emails: works council / privacy (D4), and Atlassian admins for a
   read-only service account and an agreed rate limit (F9). Both have multi-week
   lead times and neither blocks engineering.
3. Start P0-6. A federated `search_enterprise` MCP tool in Amp by end of week
   two, with query logging — which is simultaneously the product, the golden
   set, the ingestion backlog and the ACL oracle.

Everything else waits for facts.
