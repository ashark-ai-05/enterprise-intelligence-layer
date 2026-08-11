# 12 — Risk register

Ranked by expected damage, not by likelihood alone. The top three have killed
projects of this shape before; the rest are engineering.

---

## R1 — Permission drift causes a disclosure · **Critical**

**The one that ends the project.** A document visible to someone who should not
see it, discovered by that person, escalated. No amount of retrieval quality
survives it, and disclosure cannot be undone.

*Causes*: ACL sync lag or failure; a re-parent missed by body-only hashing;
group membership stamped at ingest and stale; a new retrieval arm that forgets
the predicate; graph expansion to a restricted neighbour; a reporting view that
bypasses the model.

*Mitigations*
- Fail closed everywhere: empty `acl_allow` is invisible, not universal
- ACL sync as a separate lane, 15-minute SLA, nightly reconcile
- Query-time group resolution — revocation in 5 minutes, no re-indexing
  ([05](05-acl-and-security.md) §4)
- Two-hash change detection ([ADR-0004](adr/0004-two-hash-change-detection.md))
- One predicate builder; no front door constructs SQL
- Red-team suite as a merge gate, extended on every incident
- Audit records `doc_ids`, so blast radius is answerable in minutes

*Residual*: non-zero. Assume an incident will happen and optimise for detecting
and bounding it, not for it being impossible.

---

## R2 — Never reaches production because of the approval path · **Critical**

Corporate proxy, no install rights, service accounts, a shared database, data
egress to a beta endpoint, and an index of everything the company knows. Any one
of these can absorb months.

*Mitigations*
- **Personal mode ships value with zero approvals.** This is the strategy, not a
  fallback — it buys the credibility and the usage data that make the platform
  case
- One new dependency (Postgres) instead of six
  ([ADR-0002](adr/0002-one-postgres-no-mandatory-extensions.md))
- Local embeddings mean no data egress decision on the critical path
  ([ADR-0005](adr/0005-local-first-embeddings.md))
- Engage security *with* the secret-scanning capability — it finds live
  credentials, which reframes the conversation from risk to service
- Start the Postgres provisioning request in week 1; it is the long pole and it
  is pure waiting

---

## R3 — Nobody uses it · **High**

A technically excellent index with no users. The usual cause is requiring people
to visit a new place.

*Mitigations*
- Ship into Copilot and Amp via MCP — the tools already open
- Two-phase retrieval keeps it fast enough to use reflexively
- Zero-result analysis drives what gets indexed, so the corpus follows demand
- Measure weekly-active and reformulation rate, not query count. Query count
  goes up when the system is bad

---

## R4 — Search quality is unmeasurable, so it is undefendable · **High**

Without labels, every complaint is unfalsifiable and every change is a gamble.
`eil` is here today: BM25 built and correctly not switched on, because there is
no gate.

*Mitigations*: [09](09-evaluation.md) in full. Synthetic set in week 1; gate in
CI before any ranking change; vector recall sampled on a schedule to catch the
silent failure.

---

## R5 — A blocked dependency invalidates a design assumption · **High**

`onnxruntime-node` downloads a platform binary — plausibly blocked. A package
absent from the internal mirror does not exist. Either can invalidate the
embedding plan late.

*Mitigations*
- Verify the whole dependency tree against the mirror **in week 1**
- WASM fallback (`onnxruntime-web`) — slower, no native artefacts
- Vendor model weights in the repository
- Lexical-only is a complete, useful product; semantic is an upgrade, not a
  prerequisite

---

## R6 — Source systems throttle or their owners object · **Medium**

A full backfill is the heaviest read load Confluence has seen this year, and
Jira and Confluence often share infrastructure.

*Mitigations*: agreed budget per source *host*, not per connector; off-peak
backfill; incremental per container; talk to the platform owners **before** the
first backfill, not after the first alert.

---

## R7 — Recall degrades silently as the corpus grows · **Medium**

IVF centroids built at 2M chunks describe a different index at 20M. Nothing
errors. People quietly conclude the search is not very good.

*Mitigations*: scheduled recall sampling against exact; recalibrate on corpus
doubling; persist the calibration curve so the chosen `nprobe` is auditable;
gate in CI.

---

## R8 — Extraction quality is poor and invisible · **Medium**

Unhandled Confluence macros become markup noise. Multi-column PDFs extract
interleaved and produce fluent nonsense that embeds well and means nothing.
Scanned PDFs yield nothing at all.

*Mitigations*: track unknown-macro rate as a metric; mark unextractable
documents `extraction: none` rather than indexing an empty body; sample
extracted text into the drift audit; never let a document with a suspiciously
short body count as successfully ingested.

---

## R9 — The beta MaaS endpoint becomes a hard dependency · **Medium**

It is beta. It will change, rate-limit, or disappear.

*Mitigations*: never in the retrieval hot path; circuit breaker; budget cap;
degrade to the non-model path; local model as the default for anything on a
serving path.

---

## R10 — Scope creep into a chat product · **Medium**

The pull toward "add a chat UI, add an agent, add synthesis" is strong and
consumes the effort ACL correctness and evaluation need.

*Mitigations*: [01](01-context-and-constraints.md) §7 non-goals; applications
are P4 and consume the layer rather than living inside it; retrieval stays
deterministic and model-free.

---

## R11 — Secrets in the index become a new exposure surface · **Medium**

Indexing repository history surfaces credentials removed years ago and makes
them *searchable*, which is worse than dormant.

*Mitigations*: scan before chunking and embedding; quarantine on finding; never
log the matched value; review queue; report findings to security as a service.

---

## R12 — Superseded content is confidently wrong · **Low-Medium**

An enterprise corpus is mostly superseded truth, and the old runbook is often
better written and more linked than the one that replaced it. Similarity plus
recency ranks it first and an agent acts on it. Invisible to recall@k, because
the stale document genuinely *is* topically relevant — right subject, wrong
answer.

*Mitigations*: `valid_to` / `superseded_by` as a **filter**, not a rank penalty
([06](06-retrieval.md) §4); conservative supersession detection requiring an
explicit signal; staleness on every result; escalation path to live.

---

## R13 — Cost grows without anyone watching · **Low**

Storage, embedding compute, MaaS calls, source quota.

*Mitigations*: per-tenant budget caps; chunk-level hash gating so re-embedding
is proportional to real change; retention policy; report context-characters-
saved against spend so the ratio stays visible.

---

## Summary

| # | Risk | Severity | Phase it must be handled by |
|---|---|---|---|
| R1 | Permission drift → disclosure | Critical | P2 gate |
| R2 | Approval path stalls the project | Critical | P0, continuously |
| R3 | Nobody uses it | High | P0 exit |
| R4 | Quality unmeasurable | High | P1 gate |
| R5 | Blocked dependency | High | P0 week 1 |
| R6 | Source throttling | Medium | Before first backfill |
| R7 | Silent recall decay | Medium | P1, then ongoing |
| R8 | Extraction quality | Medium | P3 |
| R9 | MaaS hard dependency | Medium | P1 design |
| R10 | Scope creep | Medium | Continuously |
| R11 | Secrets become searchable | Medium | P2 gate |
| R12 | Superseded content | Low-Med | P1 |
| R13 | Unwatched cost | Low | P3 |

**R2 and R5 are the two that are cheap now and expensive later.** Both are
resolved by a week of verification against the actual machine, and neither
requires a single architectural decision to be finalised first.
