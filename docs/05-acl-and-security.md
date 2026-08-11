# 05 — Access control and security

The load-bearing document. Enterprise search projects are rarely cancelled for
poor ranking; they are cancelled because someone found a document they should
not have been able to find.

---

## 1. Three models, and why the middle one

| | **A. Per-user index** | **B. Shared + mirrored ACLs** | **C. Late-binding check** |
|---|---|---|---|
| How | Each user ingests with their own credentials | Service account ingests; permissions mirrored into the index | Index everything; ask the source "can X read Y" at query time |
| ACL fidelity | Perfect by construction | As good as the mirror | Perfect |
| Storage | O(users × corpus) | O(corpus) | O(corpus) |
| Source load | O(users) full crawls | One crawl | One crawl + per-query calls |
| Latency | Fast | Fast | Unusable — N calls per query |
| Leak risk | None | **Permission drift** | None |
| Ceiling | ~20 users | Organisational | None, but it never ships |

**Decision: B, with a targeted C for the most sensitive slice.** Mirror
permissions, fail closed, and for documents classified `restricted` verify the
top-K against the source before returning. That confines the expensive check to
the small set where it is worth paying for.
→ [ADR-0001](adr/0001-shared-index-with-stamped-acls.md)

Model A remains correct for **personal mode** ([02](02-architecture.md) §4) and
is the right phase-0 posture. The danger is the transition: personal mode's rule
is "the ingester can read what they ingested", and if that rule survives into
platform mode — where a service account ingests everything — it grants
everything to everyone. §6 covers how the schema prevents this rather than
relying on nobody making the mistake.

---

## 2. The permission models you are actually mirroring

Generic "document has a list of groups" does not survive contact with any of
these. Each is subtractive in a way an allow-list cannot express.

### 2.1 Confluence

```
effective_view(page, user) =
      space_view_permission(space, user)          -- grant, via user or group
  AND (no view restriction on page-or-ancestor
       OR user ∈ restriction_allowlist)           -- SUBTRACTIVE, and INHERITED
```

Two properties that break naive mirrors:

- **Restrictions inherit down the page tree.** A restriction on a parent
  constrains every descendant, including descendants created later and
  descendants moved in afterwards. The ACL of a page is therefore a function of
  its *ancestry*, which means **re-parenting changes permissions without
  changing the page** — the exact case §3.2 of [04](04-ingestion-and-delta.md)
  covers.
- **A restriction is an allowlist that overrides a grant.** It cannot be
  expressed by adding groups. It must be modelled as DENY-to-everyone-else, or
  as a separate scope predicate.

Representation: emit `ALLOW` ACEs for space permission holders, and where a
restriction chain exists, emit `ALLOW` for the restriction allowlist with
`origin='restriction'` plus a `DENY` for the synthetic principal `group:*`.
Deny-wins evaluation then produces the correct result with a single array test.

### 2.2 Jira

```
effective_view(issue, user) =
      browse_projects(project, user)              -- via permission scheme → roles → users/groups
  AND (issue.security_level IS NULL
       OR user ∈ members(issue.security_level))   -- SUBTRACTIVE, per-issue
```

Project roles are an indirection the mirror must follow: a permission scheme
grants to a *role*, and role membership is per-project. Mirroring
scheme→group directly, skipping the role layer, is a common and wrong shortcut.

Issue security levels are per-issue and change without the issue body changing —
again the `meta_hash` case.

### 2.3 Bitbucket

Simplest: project-level and repo-level read grants to users and groups. No
per-file permissions. Note that a repo's *history* is readable if the repo is —
so indexing code means indexing anything ever committed, including secrets
removed in a later commit. → §7.

### 2.4 Filesystem / notes

Whatever the share's ACL says, or — for personal notes — owner-only. Do not
guess. An unmapped source defaults to `restricted`, visible to the ingesting
principal alone.

---

## 3. Evaluation, and why deny-wins

```
visible(doc, user) ⟺
      ∃ ace ∈ ACEs(doc): ace.effect = ALLOW ∧ ace.principal ∈ P(user)
  ∧  ∄ ace ∈ ACEs(doc): ace.effect = DENY  ∧ ace.principal ∈ P(user)
```

where `P(user)` is the user plus the transitive closure of their group
memberships.

Deny-wins is not a preference; it is required for correctness. Confluence
restrictions and Jira security levels both *remove* access from people who
otherwise have it, and an allow-only model has no way to represent that.

The query-time form is an integer array overlap
([03](03-data-model.md) §4). The ACE table stays authoritative: the arrays are a
**filter**, hashes can in principle collide, and the failure direction of a
collision is a false ALLOW. Therefore `get_doc` re-verifies against
`document_aces` before returning a body. Search may over-offer a title; fetch
must not over-disclose content.

---

## 4. The freshness split — the most useful idea here

Permission data changes at two very different rates, and treating it as one
problem forces the wrong trade-off on both halves.

| | **Group membership** | **Document ACEs** |
|---|---|---|
| Example | Alice joins `eng-payments`; Bob leaves the company | A page gets restricted; an issue gets a security level |
| Rate | Hourly, across the org | Weekly per document |
| Blast radius if stale | Everything that group can see | One document |
| **Resolved** | **At query time, from the directory** (cached, 5 min TTL) | **Synced into the index** |

Resolving group membership at query time is what makes revocation fast. When
someone leaves, their next query resolves to an empty group set within the cache
TTL — **no re-indexing of any document is required**. Stamping group membership
onto documents at ingest, as `eil` does today, means a departure is only fully
effective after the affected documents are re-synced, which may be days.

This split is cheap: one directory lookup per request, not per document.

**SLAs.**

| Event | Target | Mechanism |
|---|---|---|
| User deactivated | ≤ 5 min | Query-time resolution + cache TTL |
| Group membership change | ≤ 5 min | Query-time resolution |
| Page restriction added | ≤ 15 min | ACL lane sync, higher priority than content |
| Issue security level set | ≤ 15 min | ACL lane sync |
| Space permission change | ≤ 15 min | ACL lane sync; fans out to the container |
| Full ACL reconcile | Nightly | `listAcl` over all scopes, correct drift |

**The ACL lane is separate from the content lane, with its own cursor and its
own schedule.** A content backfill must never delay a permission revocation.

---

## 5. Container-first, and the ANN problem

Applying a per-document ACL predicate around an approximate vector search is a
recall trap. Pre-filtering an unpartitioned ANN index forces it toward a full
scan; post-filtering returns the global top-K and then discards most of it,
leaving the user with far fewer results than they should have — and the failure
is invisible, because a missing result looks like a corpus gap.

**Resolution: filter by container first.**

```
1. Expand P(user)                                   → ~50 principals    [cached]
2. Expand visible containers from container ACLs    → ~200 of 20,000    [cached]
3. Vector arm scans only chunks in those containers → 1-5% of corpus
4. Apply per-document ACEs to survivors             → exact
```

Step 2 is the leverage. Container permissions are coarse, stable and few, and
they eliminate 95–99% of the corpus with a btree scan before any vector work.
Per-document restrictions are rare, so step 4 discards little and overfetching
by 2× absorbs it.
→ [ADR-0007](adr/0007-container-first-acl-prefilter.md)

This is why `container` is a promoted column rather than a field inside
`hierarchy` jsonb.

---

## 6. Making the personal-mode rule impossible in platform mode

Personal mode's ACL rule — `documents.ingested_by = viewer.principal` — is safe
only because the ingester is a human whose credentials bounded what they could
fetch. Under a service account it grants the entire corpus.

Prevent structurally rather than by convention:

1. **`ingested_by` is never a service account.** A `CHECK` constraint, or an
   ingest-time refusal, rejects writes where the principal is in the service
   account set.
2. **Mode is explicit and enforced at the boundary.** `EIL_ACL_MODE = personal
   | platform`. In `platform`, the `ingested_by` clause is not in the predicate
   at all — not disabled by a flag inside the SQL string, but a different
   predicate builder, so it cannot be re-enabled by a configuration mistake.
3. **The red-team suite runs in both modes** and includes an explicit case:
   *service-account-ingested document, unrelated user, expect zero results.*

`eil` already ships an 11-scenario ACL red-team suite. Extending it is a much
better position than starting one, and it should be a merge gate.

---

## 7. Secrets, PII and the things you did not mean to index

Indexing a codebase means indexing its history, including credentials that were
removed later. Indexing Confluence means indexing the page where someone pasted
a production connection string "temporarily" in 2021.

**Pipeline order matters**: scan raw content *before* chunking and embedding.
An embedded secret is a secret in a vector you cannot inspect.

- **Detectors**: high-confidence patterns (AWS keys, private key blocks, JWTs,
  Slack tokens, connection strings with credentials) plus entropy heuristics.
  Regional PII patterns as applicable.
- **Disposition**: a finding sets `quarantined_at`, removing the document from
  every retrieval arm. Fail closed, then triage.
- **Review queue**: a human dispositions each finding. False positives are
  accepted and remembered so they do not re-trigger.
- **Never log the match.** Findings record kind, detector, location and
  confidence — not the value. A secret-detection log that contains secrets is
  a new incident.

**This work is also a service to the organisation.** A first repository scan
typically surfaces live credentials nobody knew were exposed. Frame it that way
with the security team and it becomes a reason to say yes.

---

## 8. Audit

Every read is one row: principal, tool, arguments, result count, **document ids
returned**, latency. Partitioned by time, retained per policy.

Recording `doc_ids` is the difference between "someone searched" and "these
specific documents were disclosed to this person at this time", which is the
only form useful in an actual incident.

Queries the audit log must be able to answer without new engineering:

- What did principal X see between two timestamps?
- Who has seen document Y?
- Which documents were disclosed by a permission that has since been revoked?
  *(the post-incident question, and the reason `doc_ids` is stored)*
- What fraction of searches return zero results, by source? *(quality, from the
  same table)*

---

## 9. Identity at the boundary

- Platform mode authenticates via **OIDC**. The `Viewer` is built from verified
  token claims: subject, groups (or a directory lookup keyed by subject),
  tenant.
- **No API accepts a principal, group list or tenant as a parameter.** Ever.
  This is the single most important API rule in the system.
- Personal mode's OS-user viewer is correct for stdio, where each user spawns
  their own process, and **wrong for any shared server** — every caller would
  inherit the server process's identity. `eil`'s own MCP documentation flags
  this; it must be enforced, not documented.
- Service-to-service callers (reporting jobs) get their own principal with an
  explicit, narrow ACE grant — never a bypass flag. A bypass flag will
  eventually be set in production by someone debugging.

---

## 10. Threat model

| Threat | Vector | Mitigation |
|---|---|---|
| Permission drift | ACL sync lags or fails | Separate lane, 15-min SLA, nightly reconcile, staleness alert, fail-closed default |
| Group membership stale | User leaves, index still grants | Query-time resolution, 5-min TTL (§4) |
| Re-parent leak | Move under restriction, body unchanged | `meta_hash` ([04](04-ingestion-and-delta.md) §3.2) |
| Graph traversal leak | `expand` from visible → restricted neighbour | ACL predicate re-applied to destination |
| Enumeration | Probing ids to confirm existence | Fetch requires ALLOW; not-found and not-permitted are indistinguishable |
| Snippet leak | Restricted content in a snippet from a permitted parent | Snippets generated only from ACL-passing chunks, after filtering |
| Secret exposure | Credentials in code or pages | §7 |
| Tenant crossing | Missing `WHERE tenant` | Tenant in every primary key and index prefix; predicate builder is the only path to SQL |
| Injection via content | Malicious text steering a consuming agent | Retrieval returns data, never instructions; consumers treat results as untrusted input |
| Insider misuse | Legitimate access, illegitimate volume | Audit + rate limits + anomaly alerting on result volume per principal |

The last one is worth dwelling on: a working enterprise search layer is also an
efficient exfiltration tool for anyone with legitimate access. Volume anomaly
detection on the audit log is not optional at organisational scale.
