# 14 — Prior art, gaps, and changes to make before building

A critical re-read of the whole design against systems that already solved
parts of this problem in production. Three questions:

1. Who has built this, and what did they learn that we have not?
2. Where is the design wrong, missing, or over-built?
3. What changes before the first line of code?

Every claim about an external system below was checked against its own
documentation or source, cited inline. Prior art is only useful if the citation
is real.

---

## Part 1 — Prior art

### 1.1 The closest whole-product analogue: Onyx (formerly Danswer)

[`onyx-dot-app/onyx`](https://github.com/onyx-dot-app/onyx) is the same product
shape — connectors into Confluence, Jira, Slack, Git; hybrid retrieval; chat
over the result. Its
[connector README](https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/connectors/README.md)
splits a connector into **four interfaces**, and the split is better than the
single `SourceFeed` in [13](13-system-diagram-and-tech-stack.md):

| Onyx interface | Method | What it is for |
|---|---|---|
| `LoadConnector` | `load_from_state()` | Bulk index — a point in time |
| `PollConnector` | `poll_source(start, end)` | Incremental, by time range |
| `SlimConnector` | `retrieve_all_slim_documents()` | **IDs only**, no bodies — drives the pruning job that detects deletions |
| `CheckpointedConnector` / `…WithPermSync` | — | Resumable long syncs; permission sync as its own concern |

**What to steal — `SlimConnector`.** Our design says "reconciliation sweep
detects deletions" and then does not say how without re-fetching the corpus.
Onyx's answer is a separate, cheap, **ID-only** listing. Confluence CQL and Jira
JQL both return keys far cheaper than bodies; `git ls-tree` is free. A full
deletion sweep becomes a set difference over identifiers, not a crawl.

**What to steal — checkpointing.** A 2M-page backfill *will* be interrupted.
`CheckpointedConnector` says resumption is a connector-level concern with a
serialisable position, not a "restart the job" hope. Our fenced job lease
resumes the *job*; it does not resume a half-consumed paginated cursor.

### 1.2 The ACL separation is validated: Elastic connectors

Elastic's connector framework treats permissions as a **separate sync job
type**: an *access control sync* runs independently of a content sync, writing
principal documents into a separate `.search-acl-filter-*` index, while content
documents carry an `_allow_access_control` field
([How DLS works](https://www.elastic.co/docs/reference/search-connectors/es-dls-overview)).

This is independent confirmation of the design's most contested claim: **ACL
freshness and content freshness are different SLAs and different jobs.** A
mature commercial implementation converged on the same split. Worth citing when
someone asks why permissions are not just another field on the document.

### 1.3 The gap nobody in this thread covered: ManifoldCF's authority connectors

[Apache ManifoldCF](https://manifoldcf.apache.org/release/release-2.25/en_US/concepts.html)
has been doing enterprise document-level security since 2010, and its model
contains a distinction none of the three designs in this thread made:

> "it is the job of an authority to provide a list of access tokens for a given
> searching user… Any given authority will provide access tokens for a user name
> corresponding to **one authorization domain**."

Two connector types, not one:

- a **repository connector** crawls content and attaches grant/deny tokens to
  documents;
- an **authority connector** answers, at query time, *"what tokens does this
  human hold in this source's namespace?"*

It also independently arrives at grant/deny with **deny-wins**, which is the
model in [05](05-acl-and-security.md) §3. That agreement is reassuring. The
authority/repository split is the part we are missing → **Gap 1**.

### 1.4 Permission sync at scale: Sourcegraph

Sourcegraph mirrors code-host permissions and has published how
([permission syncing](https://sourcegraph.com/docs/admin/permissions/syncing)).
Three things we did not have:

1. **Sync runs in both directions.** *Repo-centric* ("who can see this repo")
   **and** *user-centric* ("what can this user see"). Our design only has the
   container→document direction. A new joiner, or someone added to a group,
   needs the user-centric path, and we have no job that does it → **Gap 7**.
2. **Staleness is the scheduler.** Permissions are scheduled for sync when "some
   amount of time has passed since the last complete sync", into a queue
   "steadily processed to avoid overloading the code host." Permission sync is a
   rate-limited background system in its own right, not a step in ingestion.
3. **Complete and incremental sync are tracked separately** (`syncedAt` vs
   `updatedAt`). You can answer "when was this user's permission set last known
   to be *whole*", which is the only honest input to a staleness SLO.

### 1.5 The rest, briefly

| Project | Relevance | Take / skip |
|---|---|---|
| [`sourcegraph/zoekt`](https://github.com/sourcegraph/zoekt) | Trigram code search | **Skip unless approved** — Go binary vs the no-install rule. Keep the interface seam so it can drop in |
| [`sourcegraph/scip`](https://github.com/sourcegraph/scip) | Symbol index format, simpler than LSIF | **Take the format** if CI already emits it |
| [ParadeDB `pg_search`](https://www.paradedb.com/learn/search-in-postgresql/bm25), [`pg_textsearch`](https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres), VectorChord-BM25 | Real BM25 inside Postgres | **Take if an extension is ever approved** — it deletes our hand-built BM25 apparatus. → §2.4 |
| `tree-sitter` / `web-tree-sitter` | Symbol-aware chunking | **Take** — already in the stack |
| Microsoft Graph connectors, Amazon Kendra | Per-item ACL with grant/deny and user-context filtering | **Validation only** — same model, closed source |
| Apache Tika, `unstructured` | Document extraction breadth | **Skip** — Java and Python respectively; both fight the runtime and install constraints |
| Haystack, LlamaIndex, RAGFlow | RAG frameworks | **Skip in the retrieval path** — they abstract chunking, ranking and the ACL predicate, which are exactly what must stay explicit here |
| SWIRL and metasearch generally | Federate the query, index nothing | **Take as an arm, not a strategy** → §3.3 |

---

## Part 2 — Gaps, ranked by what they cost if found late

### Gap 1 — There is no identity-join plane. *(Blocking.)*

Every ACL model in this thread, including
[05](05-acl-and-security.md) §3, evaluates:

```
visible(doc, user) ⟺ ∃ ALLOW ace: ace.principal ∈ P(user) ∧ ∄ DENY ace: …
```

`P(user)` silently assumes **one principal namespace**. It is not one. In a real
org:

| Namespace | Principal looks like |
|---|---|
| Active Directory / Entra | `DOMAIN\jsmith`, or an objectGUID, or a UPN |
| Atlassian Cloud | opaque `accountId` — deliberately **not** an email |
| Atlassian Server/DC | a username, historically an email, not always |
| Bitbucket | its own user record |
| Jira project role | `roleactor` — a **per-project** principal that is not a directory group at all |
| Confluence | space permission subjects, plus `confluence-users` style pseudo-groups |

A DENY ACE emitted with an Atlassian `accountId` never matches a `P(user)` built
from AD groups. It does not error. **It silently fails open or closed**, and
which one it does depends on the evaluation order — the worst possible failure
mode for a permission system.

**Fix — adopt ManifoldCF's split.** Principals become
`(authorization_domain, identifier)`. A separate `principal_map` resolves a
directory identity into per-domain identities, and each source ships an
*authority* implementation alongside its feed. The rule that makes it safe:
**an unmapped principal is a DENY, never an ignore.** Add a `principal_map`
coverage metric — if it is not ~100% for a source, that source is not ready for
platform mode.

### Gap 2 — ACLs stored by copy make one permission change a mass rewrite. *(Blocking, data-model.)*

[03](03-data-model.md) stamps effective ACEs per document. Then someone changes
a *space* permission — and 200,000 documents need rewriting, transactionally,
while queries run. That is not a background job, it is an outage. Group deletion
is worse.

**Fix — store ACLs by reference, resolve at query time.** A document carries a
`container_id` and *only its own overrides* (a page restriction, an issue
security level). Container ACEs live once. Effective visibility becomes:

```
container ALLOW  ∧  ¬container DENY  ∧  ¬doc-override DENY  ∧  (doc-override ALLOW if present)
```

A space permission change is then **one row**. This composes perfectly with the
container-first pre-filter in [06](06-retrieval.md) §4 — the container set is
already being expanded per query, so the container ACE is already loaded. It
costs one extra predicate on the hot path and removes the entire mass-rewrite
class of failure.

This is the single largest change to the design, and it is much cheaper now than
after 2M documents carry stamped ACEs.

### Gap 3 — Jira comment-level visibility is not modelled, and we chunk comments separately.

Jira comments carry their **own** visibility restriction, independent of the
issue: either a `grouplevel` **or** a `roleactor` (project role) — Jira rejects
both at once with `Cannot specify both group level and role level comment
visibility`
([Atlassian](https://support.atlassian.com/jira/kb/add-restricted-comments-on-jira/),
[REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)).
Child comments inherit their parent's visibility.

Both Codex's design and mine chunk comments as individually addressable units,
and both attach the *issue's* ACL to them. **That is a disclosure bug**, and a
mundane one: internal comments on a Service Management ticket are restricted
precisely because they are not for the reporter.

**Fix.** ACEs attach at chunk granularity where the source has sub-document
permissions. Add a `chunk_aces` overlay — sparse, populated only when a chunk's
restriction differs from its document's. Two red-team cases: a restricted
comment on an unrestricted issue, and a role-restricted comment where the viewer
is in the *group* of the same name but not the *role*.

### Gap 4 — "BM25" is being said loosely in this thread.

PostgreSQL's `ts_rank`/`ts_rank_cd` is **not** BM25. It has no IDF term and no
proper document-length normalisation
([ParadeDB](https://www.paradedb.com/learn/search-in-postgresql/bm25),
[TigerData](https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres)).
Without IDF, a rare, highly diagnostic term is weighted like a common one — the
single biggest determinant of lexical quality on an enterprise corpus, where
every page contains "service", "platform" and "team".

[06](06-retrieval.md) §"The BM25 gap" and
[ADR-0002](adr/0002-one-postgres-no-mandatory-extensions.md) already state this
and specify the hand-built apparatus (`lexeme_stats`, `corpus_stats`,
`chunks.len`). The correction is to the **thread**, where all three of us used
"BM25" as if stock Postgres provided it. Nobody should start building believing
lexical ranking is free.

Three honest options, decide explicitly: hand-build BM25 (`eil` has most of it),
take `pg_search`/`pg_textsearch` **if** an extension is ever approved, or accept
`ts_rank_cd` and let semantic + RRF compensate. Option three is defensible for a
pilot and indefensible without saying so.

### Gap 5 — Webhooks assume inbound network ingress that probably does not exist.

Codex's design has "webhook plus poll"; mine and Sonnet's assume polling. A
webhook requires **Atlassian Cloud to open a TCP connection into the corporate
network**, to a service with a publicly resolvable name and a certificate. In an
org strict enough to forbid software installation and route all egress through a
proxy, inbound ingress from a SaaS vendor is a firewall exception, a security
review and a load balancer.

**Fix — design poll-only, treat webhooks as a later optimisation.** This is not
a downgrade: webhooks are a latency optimisation, never a correctness mechanism
(Codex is right that reconciliation is what makes it correct). Five-minute
polling is achievable on day one and needs no network change. If ingress is ever
granted, webhooks reduce p50 lag and change nothing else.

### Gap 6 — Confluence body format is an unmade decision that changes every chunk.

`body.storage` is XHTML with macros **unexpanded** — an `include` macro is an
empty tag, a Jira-issues macro is a placeholder, a table of contents is nothing.
`body.export_view` returns rendered HTML, but rendering "triggers requests to
render the macros"
([Atlassian dev community](https://community.developer.atlassian.com/t/confluence-server-rest-api-prevent-macro-expansion-in-content-fetch-using-body-export-view/62550)) —
so a bulk crawl of `export_view` makes Confluence execute macros at crawl rate,
and macros that query Jira will hammer Jira through Confluence.

Neither is simply correct:

| | `body.storage` | `body.export_view` |
|---|---|---|
| Macro content | Missing — silent content loss | Present |
| Crawl cost | Low | High, and **amplified onto other systems** |
| Determinism | Content-hash stable | Changes when *included* content changes — the hash lies |
| Rate-limit risk | Normal | Can trip Confluence *and* Jira |

That last row is subtle and matters: with `export_view`, `content_hash` reflects
transcluded content, so a page "changes" when a page it includes changes. That
is arguably correct behaviour and definitely surprising cost.

**Recommendation — `body.storage` as the indexed body, plus an explicit
macro-handling table**: expand `include`/`excerpt` by following the reference
(you have the target indexed anyway), render `code`/`table` structurally, and
**count unknown macros as a metric**. [04](04-ingestion-and-delta.md) §220
already says to track unknown macros; this promotes it to the format decision it
belongs to.

### Gap 7 — No user-centric permission sync.

Covered in §1.4. Our design syncs container→document. Nothing answers "this user
just joined; what can they see?" or "this user's groups changed 30 seconds ago".
Query-time group resolution (mine, [ADR-0001](adr/0001-shared-index-with-stamped-acls.md))
handles *group membership* churn well — but not a user newly granted access to a
space whose container ACEs were synced yesterday.

**Fix.** A `principal_permissions` staleness table with its own scheduler and
rate-limited queue, per Sourcegraph, plus `synced_at`/`updated_at` split so
"last known complete" is answerable.

### Gap 8 — Nothing in any design handles internal jargon, and it is the top quality problem.

Enterprise search fails on acronyms and codenames. "PHX" is the payments
platform; "the ledger rewrite" is a project with a real name nobody uses; "CAB"
means one thing in change management and another in a specific team. BM25 cannot
match `PHX` to `Phoenix Payments Platform`. A general-purpose embedding model
has never seen either and will place them randomly.

**Fix — build an alias dictionary from structure you already ingest, for free:**

| Alias source | Yields |
|---|---|
| Jira project keys + names | `PHX` → `Phoenix Payments Platform` |
| Confluence space keys + names | `ARCH` → `Architecture` |
| Repository names + descriptions | `phx-ledger` → payments, ledger |
| Component/label vocabularies | The org's own controlled terms |
| Page titles containing "(also known as)", "aka", "formerly" | Renames |
| Redirect/moved-page trails | Historical names still in use |

Expand queries with it at retrieval time, and boost exact alias hits. This is a
few hundred lines, needs no model, and on an enterprise corpus is worth more
than any reranker. **It is the single highest-ROI feature missing from all three
designs.**

### Gap 9 — A prose embedding model is being used for code.

`bge-small-en-v1.5` is trained on prose. Code retrieval quality from a prose
model is meaningfully worse than from a code-trained model, and worse than plain
identifier search for most real queries.

**Fix — one of two, both fine:** use a code-trained embedding model for the code
arm (a second `Embedder` behind the same interface — the design already supports
two vector spaces via the model-id column), **or** ship phase-1 code search with
*no* semantic arm at all. The second is the honest default: trigram + symbols
answers the large majority of code queries, and it is Sonnet's point that code
queries are structurally different. Do not spend the backfill budget embedding
20M code chunks with a prose model to find out.

### Gap 10 — Indexed content is untrusted input to Amp and Copilot.

[05](05-acl-and-security.md) has one line on injection and
[08](08-serving-and-front-doors.md) §5.3 tells consumers to treat results as
data. That is necessary and not sufficient, because **we are deliberately
feeding this to agents**. Anyone who can edit a Confluence page can write text
aimed at an agent reading it — and in an org, "anyone who can edit a page" is
most of the company. Combined with an agent that has write-capable MCP tools,
retrieved content becomes a path to action.

**Fix.** Three cheap measures, all in the serving plane: wrap returned content in
explicit provenance markers naming it as retrieved third-party data; scan and
flag injection-shaped patterns at ingest (`ignore previous instructions`, hidden
white-on-white text, zero-width characters) as a document-level flag, not a
block; and state in [08](08-serving-and-front-doors.md) that **a consumer must
not combine retrieval results with write-capable tools in the same agent loop
without a human confirmation step.**

### Gap 11 — Evaluation has a cold-start problem with a free answer.

[09](09-evaluation.md) requires a golden set before any ranking change, and
bootstraps from query logs. Before launch there are no query logs.

**Fix — harvest labels from the link graph you are already building.** The corpus
contains thousands of implicit relevance judgements:

- A Jira issue linking a Confluence page → *(issue summary, page)* is a labelled
  pair. A human decided that page was relevant to that text.
- A commit message citing an issue key → *(commit message, issue)*.
- A runbook linking a dashboard → *(alert name, runbook)*.

This yields a few thousand weakly-labelled pairs on day one, at zero
annotation cost. Weak labels, but enough to catch a regression, and vastly
better than shipping ranking changes blind for three months.

### Gap 12 — Two non-technical blockers nobody has raised.

- **Works council / data protection.** In a large org, especially with EU
  employees, building a system that indexes and makes searchable everything
  employees wrote — including Jira comments naming individuals — can require
  works council consultation or a DPIA. This has stopped projects at a later
  stage than this one. One conversation now.
- **Source system owners.** Confluence and Jira admins will notice a new
  service crawling their instance. Getting a service account with read access
  and an agreed rate limit is a people problem with a lead time measured in
  weeks. Start it before you need it.

### Gap 13 — Where do the processes run? *(Still unanswered.)*

Sonnet ranked this first among open questions and was right. Nothing above
matters if there is no approved place to run a long-lived worker and a database.
The two honest branches:

- **No approved app platform** → personal mode is the *whole product* for now.
  It genuinely works, delivers real value, and needs no approvals. Build it and
  stop pretending phase 3 is scheduled.
- **An approved platform exists** → its constraints (secret management, egress
  policy, no persistent local disk, restart behaviour) shape the deployment
  design, and should be gathered before, not during, phase 2.

---

## Part 3 — Changes to make before building

### 3.1 Design changes (highest value first)

| # | Change | Touches |
|---|---|---|
| 1 | **ACLs by reference** — container ACEs + sparse document overrides, resolved at query time | [03](03-data-model.md), [05](05-acl-and-security.md), [06](06-retrieval.md) |
| 2 | **Identity-join plane** — `(authorization_domain, identifier)` principals, `principal_map`, per-source authority resolver, unmapped ⇒ DENY | [05](05-acl-and-security.md) — new section, new ADR |
| 3 | **`chunk_aces` overlay** for sub-document permissions (Jira comments first) | [03](03-data-model.md), [05](05-acl-and-security.md) |
| 4 | **Split `SourceFeed` into four interfaces**, Onyx-style — load, poll, slim, authority | [ADR-0003](adr/0003-source-feed-contract.md), [13](13-system-diagram-and-tech-stack.md) |
| 5 | **User-centric permission sync** with its own staleness scheduler and queue | [05](05-acl-and-security.md), [10](10-operations.md) |
| 6 | **Alias/jargon dictionary** built from project keys, space names, repo names; query expansion at retrieval | [06](06-retrieval.md) |
| 7 | **Poll-only ingestion**; webhooks demoted to a later latency optimisation | [04](04-ingestion-and-delta.md) |
| 8 | **Confluence body-format decision** — `body.storage` + explicit macro table + unknown-macro metric | [04](04-ingestion-and-delta.md) |
| 9 | **Code semantic arm deferred** or given a code-trained model | [06](06-retrieval.md), [13](13-system-diagram-and-tech-stack.md) |
| 10 | **Injection posture** — provenance markers, ingest-time flagging, no retrieval+write in one agent loop | [08](08-serving-and-front-doors.md) |
| 11 | **Link-graph label harvesting** as the day-one golden set | [09](09-evaluation.md) |

### 3.2 Cut before building

Over-design costs the same as under-design and is harder to notice.

| Cut | Why |
|---|---|
| **Multi-tenancy machinery** | One organisation. Keep the `tenant` column — it is free and unremovable later — and delete tenant *isolation* design until a second tenant exists |
| **DLP classification tiers** | Secret scanning: keep, it is a real leak. A classification taxonomy nobody has agreed: speculative. Mirror the source's own classification if it has one, otherwise do not invent one |
| **The optional cross-encoder reranker, for now** | It is off by default and gated on evaluation that does not exist. It is dead weight in phase 1 |
| **Grafana/observability connector** | Even definitions-only. It is the least valuable source and the most novel connector. After the first three prove the pipeline |
| **Object store, in personal mode** | Content-addressed files on disk. Add the object store when there is a platform to put it in |

### 3.3 One addition: a federated arm in phase 0

Both Codex and I placed live MCP tools as the *escalation* path. There is a
stronger version: make federation **arm 6** from day one — dispatch the query to
Confluence's and Jira's own search APIs in parallel with the index arms, and
fuse the results by RRF like any other arm.

| | Federated arm | Indexed arms |
|---|---|---|
| ACL correctness | **Perfect** — the source enforces it | Mirrored, can drift |
| Freshness | **Live** | Up to one poll interval stale |
| Semantic recall | None | The whole point |
| Cross-source ranking | None | The whole point |
| Latency | Source-dependent, often poor | Controlled |
| Cost to build | **Days** — you already have the MCP clients | Months |

Two reasons this is worth more than it looks. First, **useful output in week
one**, before ingestion has proven anything — cross-source federated search is
already better than what people have today, which is three browser tabs. Second,
**it is the ACL oracle**: run the same query federated and indexed, and any
document the index returns that federation does not is a **permission mirroring
bug, caught automatically**. That is a continuous correctness test for the
hardest part of the system, and nothing else in the design provides one.

It also de-risks the whole programme. If ingestion turns out to be blocked —
rate limits, credentials, works council — the federated layer still works.

---

## Part 4 — Revised phase 0

Two weeks, one person, no approvals beyond a read-only credential.

1. Run the nine-item constraint checklist in
   [ADR-0009](adr/0009-proxy-and-no-install-runtime.md). Every item is a fact.
   Nothing below survives a `NO` on items 1, 3 or 7.
2. **Federated arm only.** One MCP tool, `search_enterprise`, fanning out to
   Confluence and Jira search, RRF over the results, citations. No index, no
   database, no embeddings. Ship it to yourself and three colleagues.
3. Instrument it. Every query, every zero-result, every click. **This is the
   golden set and the ingestion backlog, generating itself.**
4. In parallel, harvest link-graph labels into a first eval set.
5. Only then start ingestion — with the source your own query logs say matters
   most, which will probably not be the one you would have guessed.

The design in docs 01–13 remains the target. This changes where you start, and
it means the expensive, ACL-critical, hard-to-reverse parts get built against
measured demand and a working correctness oracle rather than an assumption.

---

## Sources

- [onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx) · [connector README](https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/connectors/README.md)
- [Elastic connectors — How DLS works](https://www.elastic.co/docs/reference/search-connectors/es-dls-overview)
- [Apache ManifoldCF — Concepts](https://manifoldcf.apache.org/release/release-2.25/en_US/concepts.html)
- [Sourcegraph — Permission syncing](https://sourcegraph.com/docs/admin/permissions/syncing)
- [ParadeDB — Implementing BM25 in PostgreSQL](https://www.paradedb.com/learn/search-in-postgresql/bm25) · [TigerData — from ts_rank to BM25](https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres)
- [Atlassian — Restrict comments to project roles or groups](https://support.atlassian.com/jira/kb/add-restricted-comments-on-jira/) · [Jira Cloud REST API — issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Atlassian developer community — `body.export_view` macro expansion](https://community.developer.atlassian.com/t/confluence-server-rest-api-prevent-macro-expansion-in-content-fetch-using-body-export-view/62550)
- [sourcegraph/zoekt](https://github.com/sourcegraph/zoekt) · [sourcegraph/scip](https://github.com/sourcegraph/scip)
