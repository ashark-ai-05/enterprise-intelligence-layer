# 04 — Ingestion and delta synchronisation

The requirement is "any new data should be ingested — the delta rather than
complete re-ingestion". That requirement is easy to state and has roughly six
ways to get quietly wrong. This document enumerates them.

---

## 1. The Source Feed Contract

Every connector implements the same five operations. Connectors that cannot
implement one declare it unsupported and the platform degrades predictably
rather than silently.

```ts
interface SourceFeed {
  /** Changes since a cursor. The only operation on the live path. */
  listChanges(scope: Scope, cursor: Cursor | null, limit: number): Promise<{
    items: ChangeRef[];        // { externalId, version, updatedAt, containerRef }
    nextCursor: Cursor | null;
    watermark: Date;           // source-reported "complete as of"; see §3
    complete: boolean;         // false => more pages remain in this window
  }>;

  /** Full content for one item. Called only when a hash comparison says to. */
  fetchItem(externalId: string): Promise<RawItem>;

  /** Every id in scope. Deletion detection only. Expensive; scheduled, not live. */
  listAll?(scope: Scope): AsyncIterable<{ externalId: string; version: string }>;

  /** Permission entries. Its own cursor, its own SLA. See 05. */
  listAcl?(scope: Scope, cursor: Cursor | null): Promise<{
    aces: AceRef[]; nextCursor: Cursor | null;
  }>;

  /** Container inventory: spaces, projects, repos — the ACL and partition unit. */
  listContainers(): Promise<Container[]>;
}
```

Two design points worth defending.

**`listChanges` returns references, not content.** Fetching bodies for items
that turn out to be unchanged is the dominant waste in naive delta sync. The
reference carries enough (`version`, `updatedAt`) to skip most fetches entirely.
On a typical Confluence day this is the difference between 300 fetches and
40,000.

**Scope is a parameter, not a config.** Per-scope cursors mean one broken space
does not stall the instance, and they let backfill and live sync progress
independently over the same source.

---

## 2. Per-source capability matrix

Connectors differ in what they can honestly support, and pretending otherwise
produces silent gaps.

| Source | Change feed | Version token | Deletions | ACL feed | Notes |
|---|---|---|---|---|---|
| **Confluence** | CQL `lastModified >= X` | `version.number` | `listAll` per space | Space perms + page restrictions | Restrictions are subtractive and inherit down |
| **Jira** | JQL `updated >= X` | `fields.updated` | `listAll` per project | Permission scheme + roles + issue security | Issue security is per-issue and subtractive |
| **Bitbucket** | Commit range since SHA | Commit SHA | Implicit in commit diff | Project/repo read grants | **The only source with an exact delta** |
| **Files / notes** | Directory walk + mtime | mtime + size | Walk *is* the full listing | Filesystem ACL or inherited | Reconciles for free |
| **PDF attachments** | Parent document's feed | Parent version | Parent's tombstone | Inherits parent's ACEs | Never independently permissioned |
| **Grafana / logs** | — | — | — | — | **Not ingested.** [ADR-0010](adr/0010-what-not-to-index.md) |

Bitbucket deserves note: because git gives an exact, ordered, content-addressed
diff between two commits, repo sync is the only lane that is *provably*
complete. Every other source is a best-effort poll with a reconcile safety net.
This asymmetry should inform how much you trust each source's freshness metric.

---

## 3. Change detection — the six failure modes

### 3.1 The window-edge miss

Naive: store `cursor = max(updatedAt)` seen; next run query `updated > cursor`.

This loses items. A document written inside a transaction that commits after
your query ran, but with an `updatedAt` before your watermark, is never seen
again — it falls permanently into the gap. Clock skew between the source's
database and its API layer widens the gap.

**Fix: overlap.** Persist `watermark = max(updatedAt) - OVERLAP`, where
`OVERLAP` covers clock skew plus commit latency. Start at **10 minutes** and
tune from measurement. Re-reading the overlap window every cycle is nearly free
because the hash gate makes unchanged items no-ops — this is precisely what the
hash gate is *for*.

```
cursor_next = max(item.updatedAt for item in batch) - OVERLAP
```

### 3.2 The single-hash trap

**This is the most consequential bug in the class, and the `eil` prototype has
it.** Its documentation states "content is hash-gated, so unchanged docs are
no-ops", with `content_hash = sha256(body)`.

Consider a Confluence page moved from a public space into a restricted one.
Body bytes: identical. Content hash: identical. Ingestion: skipped. The catalog
retains the old container, the old hierarchy, and — critically — the old
inherited view restrictions. **A document that just became confidential remains
searchable by everyone who could see it before.**

The same shape covers: re-parenting, retitling, label changes, Jira status and
assignee transitions, and issue security level changes.

**Fix: two hashes.**

```
content_hash = sha256(normalised body)
meta_hash    = sha256(title | container | hierarchy | labels | status |
                      acl_fingerprint | valid_to | source_version)
```

Three outcomes instead of two:

| Comparison | Action | Cost |
|---|---|---|
| both match | no-op | one row read |
| meta differs only | update metadata, hierarchy, ACEs. **Keep chunks and vectors** | one row write |
| content differs | re-chunk; re-embed only chunks whose own hash changed | proportional to real change |

The middle row is the whole point: correct *and* cheap. Re-embedding 400 chunks
because someone fixed a typo in a page title is waste; skipping the update
because the body did not change is a disclosure.
→ [ADR-0004](adr/0004-two-hash-change-detection.md)

### 3.3 Deletions are invisible to change feeds

No cursor-based feed reports what stopped existing. Three mechanisms, in
preference order:

1. **Source events** where they exist. Confluence and Jira webhooks can carry
   delete events. Treat as a latency optimisation, never as the guarantee —
   webhook delivery is at-most-once in practice.
2. **Scheduled reconcile.** `listAll(scope)` returns every id; anything in the
   catalog for that scope and not in the listing is tombstoned. This is
   expensive, so **round-robin scopes** rather than reconciling everything
   nightly: with 400 Confluence spaces and 20 reconciled per night, every space
   is verified every 20 days, at a bounded and predictable cost. Prioritise
   scopes by sensitivity, not by size.
3. **Lazy tombstone.** Any 404 during `refresh_doc` or an escalation tombstones
   immediately. Free, and it covers the documents people actually touch.

**A scoped reconcile must never delete outside its scope.** `eil` gets this
right and it is worth restating: a per-space listing cannot decide the fate of
documents in other spaces, and code that assumes otherwise will delete the
corpus the first time someone passes a narrow scope.

### 3.4 Out-of-order writes

Two workers, one document, retry in flight: the older version can land last and
regress the catalog. Guard every write:

```sql
UPDATE documents SET ... WHERE tenant = $1 AND id = $2
  AND (source_version IS NULL OR source_version <= $newVersion)
```

Cheap, and it converts a rare corruption into a no-op.

### 3.5 Pagination drift

Deep pagination over a mutating result set skips and duplicates rows: an item
edited during your walk moves in the sort order. Duplicates are harmless (hash
gate). Skips are not.

**Fix**: sort by an immutable-within-window key, prefer keyset pagination over
offset, and treat any run where `complete` never became true as a failed cycle
that must not advance the cursor.

### 3.6 Cursor advanced before the work committed

The obvious one, and still the most common. **The cursor advances in the same
transaction as the batch it covers, or after it — never before.** A crash then
costs a repeat, not a gap. Repeats are free here; gaps are permanent and silent.

---

## 4. Two lanes

| | **Backfill** | **Live delta** |
|---|---|---|
| Trigger | Onboarding a scope; re-embed after model change | Schedule, every 5 min |
| Volume | Millions | Hundreds |
| Priority | Lowest; yields to live | Highest |
| Window | Off-peak, rate-capped against source limits | Continuous |
| Restartable | Per scope, per page | Per item |
| Failure | Pause scope, alert, resume | Retry with backoff, dead-letter after 5 |

Separate priority classes on one queue, not one queue processed in order. A 2M
page backfill that starves the five-minute delta produces a system that is
simultaneously busy and stale, which is the worst available outcome and the
easiest to ship by accident.

**Rate limiting is a source-level budget, not a per-connector setting.** Jira
and Confluence frequently share an infrastructure tier; saturating one degrades
the other, and the first sign is an angry platform team. Budget per *source
host*, and make the ceiling a configuration the source's owners have agreed to.

---

## 5. Normalisation

Everything becomes markdown. One body format means one chunker, one snippet
generator, one diffing strategy, one set of golden tests. `eil` made this call
and it is correct.

Per-source specifics that actually matter:

- **Confluence storage format** is XHTML with macros. Macros must be handled
  explicitly: expand what carries meaning (`code`, `info`, `expand`, tables),
  drop what is chrome (`toc`, `children`, `panel` wrappers). Silently rendering
  an unknown macro as its raw XML fills the index with markup that matches
  nothing and dilutes BM25 length normalisation. **Track unknown macros as a
  metric** — it is the honest measure of extraction quality.
- **Jira** ADF (Atlassian Document Format) or wiki markup depending on
  deployment. Comments carry author and timestamp, which are load-bearing → §6.
- **Code**: no normalisation. Preserve bytes; the tokenizer handles it.
- **PDF**: `pdf.js` is pure JavaScript and works under the no-install
  constraint. Extract text with layout awareness; multi-column PDFs extracted
  naively interleave columns and produce fluent nonsense that embeds *well* and
  means nothing. **A PDF with no extractable text layer is a scanned image**:
  mark it `extraction: none` and index the metadata only. Do not pretend. OCR
  requires binaries and is out of scope → [01](01-context-and-constraints.md) §2.

---

## 6. Chunking is per-type, and this matters more than it sounds

A single prose chunker applied to everything is the most common quality defect
in systems of this shape.

**Confluence / notes — heading-aware.** Split on heading boundaries, carry the
heading path into each chunk, keep tables whole (a table split mid-row is
noise), target ~500 tokens with ~15% overlap.

**Jira — an issue is a conversation, not a page.** Chunking an issue as flat
prose is why "what did we decide about retry limits" returns a comment from
2023 with no indication it was superseded. Produce:

| Chunk | Content | `chunk_kind` |
|---|---|---|
| 1 | Summary + description | `prose` |
| 2..n | One per comment, with author and timestamp | `comment` |
| n+1 | **Synthesized state**: status, resolution, assignee, fix version, linked issues | `state` |

The synthesized state chunk is the one that makes "is this done" answerable
without a live call, and it is the one a generic chunker never produces.

**Code — symbol-aware, not line-window.** `eil` uses overlapping line windows,
which is a reasonable answer under a no-native-dependency constraint. But
`web-tree-sitter` is WASM, installs from npm with no compilation, and gives real
symbol boundaries. Chunk at function/class granularity with the enclosing
signature and file path as the heading path. A chunk that begins mid-function
is a chunk that cannot be cited.

**PDF — page-aware with heading detection**, locator carrying page number, so a
citation is verifiable.

---

## 7. Enrichment

Ordered by value per unit of effort:

1. **Lexical index** — free, generated column. Always.
2. **Link extraction** — cheap and high value. Ticket keys, Confluence page
   ids, repo paths, URLs. Because ids are deterministic ([03](03-data-model.md)
   §1), resolution needs no database lookup.
3. **Secret and PII scan** — mandatory before anything is retrievable. Runs on
   raw content pre-chunking. A finding quarantines the document; triage follows.
   Ingesting a repository *will* surface credentials, and finding them in your
   search index during a security review is a bad way to learn this.
4. **Embedding** — the expensive one. Gated by chunk-level content hash so
   unchanged chunks are never re-embedded. → [ADR-0005](adr/0005-local-first-embeddings.md)
5. **Temporal validity** — detect supersession signals: "deprecated", "moved
   to", "superseded by", archived space, Jira resolution. Sets `valid_to` and
   `superseded_by`. Conservative by design: a false positive hides a valid
   document, so require an explicit signal rather than inferring from age.
6. **Classification** — inherited from container, overridden by explicit labels.

---

## 8. Model changes are a corpus event

Changing the embedding model invalidates every vector. `eil` handles this
correctly by scoping the semantic arm to the current `embed_model`, so a switch
degrades to lexical-only until backfill completes, rather than silently
comparing across incompatible vector spaces.

The operational shape at 20M chunks: **plan for a multi-day re-embed**, run it
in the backfill lane, keep the old model's vectors until the new set is
complete, then switch atomically and drop. Storage doubles transiently — budget
for it. IVF centroids must be rebuilt and `nprobe` recalibrated afterwards,
because the previous calibration was measured against a different index.

---

## 9. What "done" looks like per cycle

Every sync cycle emits one structured record. Without it, "is ingestion
healthy" is answered by opinion.

```json
{
  "source": "confluence", "scope": "ENG", "lane": "live",
  "window": { "from": "...", "to": "..." },
  "seen": 412, "unchanged": 380, "meta_only": 19, "content_changed": 13,
  "fetched": 32, "chunks_written": 141, "chunks_embedded": 141,
  "tombstoned": 0, "aces_updated": 19,
  "errors": [], "duration_ms": 8140, "cursor_advanced": true
}
```

`seen` versus `fetched` is the delta efficiency ratio and the number to watch:
if it approaches 1.0, change detection has stopped working and you are doing a
full re-ingest while believing you are not.
