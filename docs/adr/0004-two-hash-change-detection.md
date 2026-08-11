# ADR-0004 — Two hashes (content + metadata), not one

**Status**: Proposed · **Date**: 2026-08-11 · **Corrects**: `eil`'s single
`content_hash` gate

---

## Context

Delta ingestion needs a cheap test for "has this changed". `eil` uses
`content_hash = sha256(body)` and documents the behaviour as: *"content is
hash-gated, so unchanged docs are no-ops"*.

That is correct for the body and silently wrong for everything else about a
document.

---

## The failure

A Confluence page is moved from an open space into a restricted one.

| Property | Before | After |
|---|---|---|
| Body bytes | unchanged | unchanged |
| `sha256(body)` | `abc123…` | `abc123…` |
| Container | `ENG` | `SEC-RESTRICTED` |
| Inherited view restrictions | none | `security-team` only |
| **Ingestion outcome** | — | **skipped as unchanged** |

The catalog keeps the old container, the old hierarchy and the old ACL. **A
document that just became confidential remains searchable by everyone who could
see it before**, indefinitely — until a full reconcile happens to touch it.

This is not a hypothetical. Re-parenting is routine, Confluence restrictions
inherit down the page tree ([05](../05-acl-and-security.md) §2.1), and the same
shape covers Jira issue security levels, status transitions, retitling and label
changes. In every case the body is untouched and the metadata is not.

---

## Decision

**Two hashes, three outcomes.**

```
content_hash = sha256(normalised body)
meta_hash    = sha256(title | container | hierarchy | labels | status |
                      acl_fingerprint | valid_to | source_version)
```

| Comparison | Action | Cost |
|---|---|---|
| both match | no-op | one row read |
| **meta differs only** | update metadata, hierarchy, ACEs. **Keep chunks and vectors** | one row write |
| content differs (± meta) | re-chunk; re-embed only chunks whose own hash changed | proportional to real change |

---

## Rationale

**The middle outcome is the entire point.** A single hash forces a false choice:
gate on the body and miss permission changes, or gate on everything and
re-chunk plus re-embed a 400-chunk page because someone fixed a typo in its
title. Two hashes make the correct action the cheap one.

**Chunk-level hashing composes with this.** Even when the body changes,
`chunks.content_hash` means only genuinely changed chunks are re-embedded — the
expensive operation stays proportional to real change rather than to document
size.

**`acl_fingerprint` inside `meta_hash` closes the loop.** A permission change
with no other metadata change still moves the hash, so the ACL lane and the
content lane cannot silently disagree about a document's state.

---

## Consequences

**Accepted**
- Connectors must return enough metadata in `listChanges` to compute
  `meta_hash` without a full fetch. Where a source cannot, `meta_hash` is
  computed after fetching — losing the fetch saving but retaining correctness.
- `meta_hash` is order-sensitive: field serialisation must be canonical, or
  every sync sees spurious changes. Sort keys; normalise whitespace; test it.
- Two columns and slightly more comparison logic.

**Required tests**, all of which are cheap and none of which pass by accident:
- Move a page under a restricted parent → ACEs updated, chunks untouched
- Retitle → metadata updated, no re-embedding
- Edit body → re-chunked, only changed chunks re-embedded
- Set a Jira issue security level → ACEs updated within the ACL lane SLA
- Change nothing → zero writes

The last one is the delta-efficiency test, and it is the one that regresses
first.
