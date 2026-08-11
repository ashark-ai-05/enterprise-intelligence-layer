# 03 — Data model

Reference DDL. **This is design, not migrations** — it is written to be argued
with, and column comments carry the reasoning. Where it agrees with `eil`'s
existing schema, that is deliberate and noted.

---

## 1. Identity and keys

**Document IDs are deterministic and source-derived**: `source:type:externalId`
— `confluence:page:12345`, `jira:issue:PAY-981`, `bitbucket:file:repo@path`.

Three properties this buys, all of which matter more than they look:
- Re-ingesting produces the same id, so ingestion is idempotent without a
  lookup table.
- A link found in a body (`PAY-981`) can be resolved to an id **without a
  database round trip**, which is what makes link-graph extraction cheap.
- An id is human-readable in an audit log, which is what makes an incident
  review possible.

Primary keys are `(tenant, id)` throughout. Tenant is mandatory on every table
that holds content, and it is the first column of every index. This is inherited
from `eil` migration 0009 and is correct: a tenant that is a filter rather than
part of the key is a tenant that a missing `WHERE` clause can cross.

---

## 2. Catalog

```sql
CREATE TABLE documents (
    tenant        text NOT NULL,
    id            text NOT NULL,            -- source:type:externalId
    source        text NOT NULL,            -- confluence | jira | bitbucket | file | pdf | grafana
    doc_type      text NOT NULL,            -- page | issue | file | attachment | dashboard | runbook
    title         text NOT NULL,
    url           text,
    author        text,

    -- Container is the ACL and partitioning unit: space key, project key, repo
    -- slug. It is the single most important column for query performance,
    -- because expanding a user's visible container set prunes the corpus BEFORE
    -- any vector work happens. See ADR-0007.
    container     text NOT NULL,
    hierarchy     jsonb NOT NULL DEFAULT '[]',   -- breadcrumb, for display and scoping

    created_at    timestamptz,
    updated_at    timestamptz,               -- source's last-edit time

    -- Temporal validity: "last edited" and "still true" are different facts.
    -- A 2023 runbook edited today to add an obsolete banner is recently updated
    -- and no longer valid. Adopted from eil migration 0024, which is right.
    valid_from    timestamptz,
    valid_to      timestamptz,               -- NULL = current
    superseded_by text,                      -- deliberately not a FK: successor may not be ingested

    -- Change detection. TWO hashes, not one. content_hash gates re-chunking and
    -- re-embedding; meta_hash gates metadata/ACL/hierarchy refresh. A page move
    -- changes meta_hash and not content_hash — with a single body hash that
    -- update is silently skipped, leaving stale inherited restrictions. See ADR-0004.
    content_hash  text NOT NULL,             -- sha256(normalised body)
    meta_hash     text NOT NULL,             -- sha256(title|container|hierarchy|labels|acl|status|valid_to)

    -- The source's own monotonic version where it has one (Confluence
    -- version.number, Bitbucket commit SHA). Guards against out-of-order
    -- workers regressing a document: writes require incoming >= stored.
    source_version text,

    body          text NOT NULL,             -- normalised markdown, the lingua franca
    lang          text,
    quality_tier  text NOT NULL DEFAULT 'authored',  -- curated | authored | generated | raw
    classification text NOT NULL DEFAULT 'internal', -- public | internal | confidential | restricted

    -- Lifecycle. Tombstones rather than deletes: a result must not outlive its
    -- source, and a hard delete loses the evidence that it once existed.
    tombstoned_at  timestamptz,
    quarantined_at timestamptz,              -- secret/PII detection pulled it out of retrieval

    ingested_at   timestamptz NOT NULL DEFAULT now(),
    synced_at     timestamptz NOT NULL DEFAULT now(),  -- staleness, reported on every result

    PRIMARY KEY (tenant, id)
) PARTITION BY LIST (tenant);

-- The hot-path partial index: current, visible, live documents only.
CREATE INDEX documents_live_idx ON documents (tenant, container, updated_at DESC)
    WHERE tombstoned_at IS NULL AND quarantined_at IS NULL AND valid_to IS NULL;

CREATE INDEX documents_source_idx  ON documents (tenant, source, doc_type);
CREATE INDEX documents_version_idx ON documents (tenant, source, source_version);
```

### Why `container` is promoted to a first-class column

In `eil` the equivalent information lives inside `hierarchy jsonb`. Promoting it
is the change that makes ANN search viable under ACL constraints: a user
typically has access to a few hundred containers out of tens of thousands, and
`container = ANY($visible)` prunes 90–99% of the corpus with a plain btree scan
before the vector funnel runs. Post-filtering an ANN result instead loses recall
in a way that is invisible until someone complains they cannot find a document
they can definitely see. → [ADR-0007](adr/0007-container-first-acl-prefilter.md)

---

## 3. Chunks and vectors

Split across two tables. The chunk row is read on every result; the vector is
read only by the semantic arm. Keeping a 1.5 KB `float4[]` out of the chunk row
keeps the chunk table narrow enough to stay in the buffer cache, which is worth
more than the join costs. `eil` migration 0020 makes the same split.

```sql
CREATE TABLE chunks (
    tenant       text NOT NULL,
    doc_id       text NOT NULL,
    seq          int  NOT NULL,

    chunk_kind   text NOT NULL DEFAULT 'prose',
        -- prose | table | code | comment | state | frontmatter
        -- Jira comments and synthesized issue-state chunks are NOT prose, and
        -- ranking them identically is why "what was decided" returns a
        -- two-year-old comment. See 04 §6.

    heading_path text NOT NULL DEFAULT '',
    text         text NOT NULL,
    content_hash text NOT NULL,              -- embed-once gate at chunk granularity
    len          int,                        -- BM25 length normalisation, stored not computed

    -- Source locator: file+line for code, page+offset for PDF, comment id for
    -- Jira. Without it, a citation cannot be verified and the answer cannot be
    -- trusted.
    locator      jsonb NOT NULL DEFAULT '{}',

    tsv      tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    -- Code tokens under 'simple': english stems `retryHandler` to `retryhandl`
    -- (unsplittable) and deletes `if`, `for`, `do`, `is` — all real code tokens.
    -- Adopted from eil migration 0017, which measured exactly this.
    code_tokens text,
    tsv_code tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(code_tokens,''))) STORED,

    PRIMARY KEY (tenant, doc_id, seq),
    FOREIGN KEY (tenant, doc_id) REFERENCES documents (tenant, id) ON DELETE CASCADE
) PARTITION BY LIST (tenant);

CREATE INDEX chunks_tsv_idx      ON chunks USING gin (tsv);
CREATE INDEX chunks_tsv_code_idx ON chunks USING gin (tsv_code);

CREATE TABLE chunk_vectors (
    tenant      text NOT NULL,
    doc_id      text NOT NULL,
    seq         int  NOT NULL,
    embed_model text NOT NULL,               -- vectors from different models never compare

    embedding   float4[] NOT NULL,           -- unit-normalised: cosine reduces to dot product
    sig         varbit   NOT NULL,           -- binary quantisation, ~30x smaller, the funnel's first pass
    cluster_id  int,                         -- IVF assignment

    PRIMARY KEY (tenant, doc_id, seq, embed_model),
    FOREIGN KEY (tenant, doc_id) REFERENCES documents (tenant, id) ON DELETE CASCADE
) PARTITION BY LIST (tenant);

CREATE INDEX chunk_vectors_ivf_idx ON chunk_vectors (tenant, embed_model, cluster_id);

CREATE TABLE ivf_centroids (
    tenant      text NOT NULL,
    embed_model text NOT NULL,
    cluster_id  int  NOT NULL,
    centroid    float4[] NOT NULL,
    n_assigned  int NOT NULL DEFAULT 0,
    built_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant, embed_model, cluster_id)
);
```

`varbit` rather than `bit(384)` is `eil`'s call and it is right: a fixed width
forces a schema migration the day a 768-dimension code embedder arrives, and
because every query filters `embed_model` first, widths are always uniform
within a comparison. Cross-width XOR raises a loud error rather than silently
comparing across vector spaces.

**Binary quantisation alone is not safe at 384 dimensions** — `eil` measured
63.5% recall@10, against the commonly cited ~95% figure which applies to 1024+
dimensions. The exact rescore of survivors is mandatory, not an optimisation.
→ [07](07-scale-and-capacity.md) §4.

---

## 4. Access control

The part that decides whether this ships. `eil`'s `acl_groups jsonb` with the
`?|` operator is allow-only, and allow-only cannot express Confluence page
restrictions or Jira issue security levels, both of which are **subtractive**.

```sql
-- Principals mirrored from the directory / source systems.
CREATE TABLE principals (
    tenant       text NOT NULL,
    id           text NOT NULL,             -- 'user:alice@corp', 'group:eng-payments'
    kind         text NOT NULL CHECK (kind IN ('user','group','role')),
    external_id  text NOT NULL,
    source       text NOT NULL,             -- ldap | confluence | jira | bitbucket
    display_name text,
    active       boolean NOT NULL DEFAULT true,
    synced_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant, id)
);

-- Nested group membership. Stored as edges; expanded transitively at query
-- time with a recursive CTE and cached per request. Groups nest 3-5 deep in
-- practice, so transitive closure is cheap; materialising it means every
-- membership change rewrites a large table.
CREATE TABLE principal_edges (
    tenant   text NOT NULL,
    parent   text NOT NULL,                 -- group
    member   text NOT NULL,                 -- user or group
    PRIMARY KEY (tenant, parent, member)
);
CREATE INDEX principal_edges_member_idx ON principal_edges (tenant, member);

-- Access control entries. ALLOW and DENY, evaluated deny-wins.
CREATE TABLE document_aces (
    tenant       text NOT NULL,
    doc_id       text NOT NULL,
    principal_id text NOT NULL,
    effect       text NOT NULL CHECK (effect IN ('ALLOW','DENY')),
    origin       text NOT NULL,   -- container | restriction | security_level | inherited
    PRIMARY KEY (tenant, doc_id, principal_id, effect),
    FOREIGN KEY (tenant, doc_id) REFERENCES documents (tenant, id) ON DELETE CASCADE
);
```

### The query-time representation

Joining `document_aces` per candidate does not survive 20M chunks. The materialised
form on `documents` is what retrieval actually filters on:

```sql
ALTER TABLE documents
  ADD COLUMN acl_allow bigint[] NOT NULL DEFAULT '{}',   -- hash64(principal_id)
  ADD COLUMN acl_deny  bigint[] NOT NULL DEFAULT '{}',
  ADD COLUMN acl_synced_at timestamptz;

CREATE INDEX documents_acl_allow_idx ON documents USING gin (acl_allow);
```

The visibility predicate becomes an index-backed array overlap:

```sql
   d.tenant = $tenant
   AND d.acl_allow && $principalHashes::bigint[]      -- GIN, fast
   AND NOT (d.acl_deny && $principalHashes::bigint[]) -- deny wins
   AND d.tombstoned_at IS NULL
   AND d.quarantined_at IS NULL
   AND d.valid_to IS NULL
```

`bigint[]` with `&&` rather than `jsonb` with `?|`: integer array overlap on a
GIN index is materially cheaper than jsonb key existence, and the deny array has
no jsonb equivalent. Hash collisions are the obvious objection — at 64 bits with
~10^5 principals the collision probability is ~10^-10, and the failure direction
is a false ALLOW, so **the ACE table remains authoritative and `get_doc`
re-verifies against it**. The array is a filter, not the decision.

> `acl_allow` defaulting to `'{}'` is the fail-closed property: an empty array
> overlaps nothing, so a document whose ACL sync has not run is invisible to
> everyone rather than visible to everyone. This must be verified by test, not
> by reading — it is the single assertion most worth red-teaming.

Full permission model per source → [05](05-acl-and-security.md).

---

## 5. Link graph

```sql
CREATE TABLE links (
    tenant text NOT NULL,
    src_id text NOT NULL,
    dst_id text NOT NULL,
    rel    text NOT NULL DEFAULT 'references',
        -- references | mentions | blocks | duplicates | implements | parent
    confidence real NOT NULL DEFAULT 1.0,   -- 1.0 = explicit link; lower = inferred from text
    PRIMARY KEY (tenant, src_id, dst_id, rel)
);
CREATE INDEX links_dst_idx ON links (tenant, dst_id);
```

No foreign key on `dst_id`, following `eil`: an edge may point at a document not
yet — or never — ingested, and a dangling edge is a **signal about what to
ingest next**, not an error. That is a genuinely good idea and it is kept.

Graph expansion must re-apply the ACL predicate to the destination document.
Traversing from a document you can see to one you cannot is the classic
knowledge-graph disclosure bug.

---

## 6. Operational tables

```sql
-- Cursors are per (source, scope), never global: a per-space Confluence sync
-- and a per-project Jira sync progress independently, and one failing scope
-- must not stall the others.
CREATE TABLE sync_cursors (
    tenant     text NOT NULL,
    source     text NOT NULL,
    scope      text NOT NULL,              -- space key, project key, repo slug, '' = whole
    lane       text NOT NULL,              -- content | acl
    cursor     text,                       -- opaque: timestamp, SHA, or page token
    watermark  timestamptz,                -- high-water mark, minus overlap. See 04 §3
    last_ok_at timestamptz,
    last_error text,
    PRIMARY KEY (tenant, source, scope, lane)
);

-- Durable queue. Adopted wholesale from eil migration 0026 — the fencing token
-- design there is correct and worth keeping: a worker whose lease expired holds
-- a stale token and every write it attempts is rejected, even before it knows.
CREATE TABLE jobs (
    id bigserial PRIMARY KEY,
    tenant text NOT NULL,
    job_type text NOT NULL,
    lane     text NOT NULL DEFAULT 'live',  -- live | backfill  (priority classes)
    payload jsonb NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','claimed','completed','dead_letter')),
    attempts int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL DEFAULT 5,
    run_after timestamptz NOT NULL DEFAULT now(),
    lease_owner text,
    lease_expires_at timestamptz,
    fence_token bigint NOT NULL DEFAULT 0,
    last_error text,
    UNIQUE (tenant, idempotency_key)
);
CREATE INDEX jobs_claimable_idx ON jobs (lane, run_after, id) WHERE status = 'pending';

-- Every read, one row. This is what makes a security review survivable, and it
-- is also the only honest source for adoption and quality metrics.
CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    tenant text NOT NULL,
    principal text NOT NULL,
    tool text NOT NULL,
    args jsonb NOT NULL DEFAULT '{}',
    result_count int,
    doc_ids text[],                        -- what was actually disclosed
    latency_ms int
) PARTITION BY RANGE (at);

-- Secret / PII findings. A finding quarantines the document out of retrieval
-- until reviewed — fail closed, then triage.
CREATE TABLE content_findings (
    tenant text NOT NULL,
    doc_id text NOT NULL,
    seq    int NOT NULL DEFAULT -1,        -- -1 = document-level finding; NULL in a PK would not dedupe
    kind   text NOT NULL,                  -- aws_key | private_key | jwt | pan | nino | email_bulk
    detector text NOT NULL,
    confidence real NOT NULL,
    reviewed_at timestamptz,
    disposition text CHECK (disposition IN ('true_positive','false_positive','accepted')),
    PRIMARY KEY (tenant, doc_id, seq, kind)
);
```

---

## 7. Storage estimate at target

At 2M documents / 20M chunks, 384-dimension embeddings. **(estimated)** — the
arithmetic is shown so it can be checked.

| Object | Per unit | Total |
|---|---|---|
| `documents` body | ~5 KB | 10 GB |
| `chunks` text | ~1.2 KB × 20M | 24 GB |
| `tsv` GIN | ~35% of text | 8.5 GB |
| `tsv_code` GIN | code chunks only, ~20% of corpus | 2 GB |
| `chunk_vectors.embedding` | 384 × 4 B + overhead ≈ 1.6 KB | **32 GB** |
| `chunk_vectors.sig` | 384 bits ≈ 56 B | 1.1 GB |
| `document_aces` | ~8 ACEs/doc × 40 B | 0.6 GB |
| Indexes, bloat, WAL headroom | — | ~25 GB |
| **Total** | | **~105 GB** |

Two conclusions. Embeddings are a third of the footprint, which is the argument
for the separate table and for the binary signature funnel. And 105 GB is
comfortably a single Postgres node — **this design does not need sharding for a
single large organisation**, and anyone proposing it should be asked for the
measurement that justifies it. → [07](07-scale-and-capacity.md).
