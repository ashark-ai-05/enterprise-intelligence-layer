# ADR-0007 — Container-first ACL pre-filter to keep ANN viable

**Status**: Proposed · **Date**: 2026-08-11

---

## Context

Every result must be ACL-filtered, and the semantic arm is an approximate
nearest-neighbour search. Combining exact filtering with approximate search is a
well-known hard problem with two obvious approaches, both bad:

**Post-filter** — run ANN globally, then discard what the user cannot see. The
user asked for 10 results; the global top-100 might contain 3 they can see. The
failure is *silent*: a missing result is indistinguishable from a corpus gap,
and the user concludes the document is not indexed.

**Pre-filter per document** — apply the ACL predicate inside the ANN scan. This
defeats the index structure: a cluster-based or graph-based index cannot prune
when an arbitrary predicate may eliminate any candidate, so it degenerates
toward a full scan.

---

## Decision

**Filter by container first, then run the approximate search inside that
subset, then apply per-document ACEs to the survivors.**

```
1. Expand P(user) — user + transitive groups        → ~50 principals   [cached 5 min]
2. Expand visible containers from container ACLs    → ~200 of 20,000   [cached 5 min]
3. Semantic arm scans only chunks in those containers → 1-5% of corpus
4. Apply per-document ALLOW/DENY ACEs to survivors  → exact
5. Overfetch 2x to absorb step 4's losses
```

This requires `container` to be a promoted, indexed column on `documents` rather
than a field inside `hierarchy` jsonb — which is why the data model
([03](../03-data-model.md)) makes that change to `eil`'s schema.

---

## Rationale

**Permissions in these systems are overwhelmingly container-shaped.** Confluence
space permissions, Jira project browse permissions and Bitbucket repository
grants cover the large majority of access decisions. Page-level restrictions and
issue security levels are the exception, not the rule.

That asymmetry is the leverage. Containers are:

- **Few** — thousands, not millions
- **Coarse** — one decision covers many documents
- **Stable** — space permissions change far less often than page content
- **Cacheable** — one expansion per user per five minutes

Filtering on them eliminates 95–99% of the corpus with a plain btree scan
*before* any vector work. Running approximate search over 3% of the corpus is
both faster and higher-recall than running it over all of it and discarding.

**The residual is small enough to absorb.** Because per-document restrictions
are rare, step 4 discards few candidates, and a 2× overfetch covers it. The
pathological case — a user with access to a container in which nearly every
document is individually restricted — is rare and detectable.

**It composes with partitioning.** Container is a natural clustering key, so the
pre-filter also improves cache locality.

---

## Consequences

**Accepted**
- `container` must be maintained accurately on every document, and it changes on
  re-parent — which is exactly why `meta_hash` exists
  ([ADR-0004](0004-two-hash-change-detection.md)).
- Container ACLs must be mirrored separately from document ACEs, with their own
  sync. A space permission change fans out to every document in the space
  logically, but is stored once.
- Cross-container semantic search over a user with access to *everything*
  degenerates to the unfiltered case. Rare, and it is the case where a full scan
  is at least correct.
- The container expansion cache is a correctness-relevant cache: a 5-minute TTL
  means up to 5 minutes of stale container access. This is the deliberate
  trade in [05](../05-acl-and-security.md) §4 and it is bounded and stated.

**Measurement that must exist**
- Distribution of containers-per-user. If the median user sees 5,000 containers
  rather than 200, the pruning assumption is wrong and this ADR needs revisiting
  with real numbers.
- Fraction of documents carrying per-document restrictions. If it exceeds ~10%,
  the overfetch multiplier must rise.

Both are cheap to measure once ACL mirroring exists, and **neither should be
assumed**. The design is built on a claim about permission shape in this
organisation, and that claim is checkable.
