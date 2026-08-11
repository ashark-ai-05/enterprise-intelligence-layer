# ADR-0001 — Shared index with mirrored ACLs, not per-user indexes

**Status**: Proposed · **Date**: 2026-08-11 · **Supersedes**: `eil`'s
personal-credential model for platform mode only

---

## Context

Whose identity the index belongs to is the decision that determines whether this
is a personal tool or an organisational platform. It is extremely expensive to
change later, because it is baked into the ingestion path, the schema and the
security review.

Three options:

**A. Per-user index.** Each user ingests with their own credentials; they can
only index what they could already read. This is what `eil` does today.

**B. Shared index, mirrored ACLs.** A service account ingests everything;
source permissions are mirrored into the index; queries filter by the caller's
expanded principal set.

**C. Late-binding verification.** Index everything; at query time ask each
source whether this user may read each candidate.

---

## Decision

**Adopt B for platform mode. Retain A for personal mode. Use C only for the
`restricted` classification, applied to the top-K after ranking.**

---

## Rationale

**A does not scale, in three separate ways.** Storage is O(users × corpus).
Ingestion load on Confluence and Jira is O(users) full crawls, which the
platform teams will notice and throttle. And nothing is shared — the same
document is fetched, chunked and embedded once per interested person, which is
precisely the cost curve the project exists to flatten. It is viable to roughly
20 users.

**C is correct and unshippable.** A per-candidate permission call to the source
is tens to hundreds of network round trips per query. It also leaks existence
through timing, and it makes the source's availability a dependency of every
search.

**B is the only option with an organisational ceiling.** Its cost is that
permission mirroring can drift, and drift is a disclosure. That cost is
manageable with deliberate engineering — a separate ACL lane with its own SLA,
deny-wins evaluation, fail-closed defaults, nightly reconcile, and a red-team
suite — and the mitigations are well understood.

**The hybrid matters.** For documents classified `restricted`, verifying the
top-10 against the source before returning costs ten calls on a small subset of
queries, and it converts the residual drift risk to near zero exactly where the
consequences are worst. Applying C to the whole corpus is unworkable; applying
it to the sensitive tail is cheap.

---

## Consequences

**Accepted**
- Permission mirroring becomes a first-class subsystem with its own connectors,
  cursors, SLA and alerting — a substantial share of P2's effort.
- A security review becomes a hard gate before any shared serving.
- The principal graph must be mirrored, including nested groups.
- Drift is a permanent operational concern requiring reconciliation.

**Required, structurally**
- Personal mode's rule (`ingested_by = viewer`) **must be impossible to reach in
  platform mode** — a different predicate builder, not a flag inside one.
  A service account ingesting everything under that rule grants everything to
  everyone. → [05](../05-acl-and-security.md) §6
- `acl_allow` defaults to empty, and empty means invisible. The failure
  direction of every ACL bug must be denial.
- Group membership is resolved at query time, not stamped, so revocation does
  not require re-indexing. → [05](../05-acl-and-security.md) §4

**Rejected alternatives, for the record**
- *Index only public content.* Removes most of the value; the useful knowledge
  is in restricted spaces.
- *Per-team indexes.* A partial A; inherits its costs and adds cross-team
  discovery as a new problem.
- *Trust the source's search API and federate.* No unified ranking, no semantic
  arm, N× latency, and each source's search is the thing users are already
  dissatisfied with.
