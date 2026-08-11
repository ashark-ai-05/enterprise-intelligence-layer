# ADR-0008 — Existing MCP tools serve the live lane, not the index lane

**Status**: Proposed · **Date**: 2026-08-11

---

## Context

MCP tools already exist for Jira, Confluence, Bitbucket, logs and Grafana. The
tempting conclusion is that the index should be built by calling them — the
integration work is done, the credentials are configured, the access is proven.

---

## Decision

**Existing MCP tools are the escalation path and the write path. Bulk ingestion
uses the underlying REST APIs directly, through connectors implementing the
Source Feed Contract.**

---

## Rationale

### MCP tools are question-shaped; ingestion needs feed-shaped

A tool designed for an agent answers *"find issues about payment retries"*. A
connector needs *"give me every issue in project PAY updated since timestamp T,
paginated, with a stable sort, and tell me when the window is complete"*.

Those are different contracts. Specifically, question-shaped tools typically
lack:

- **Stable pagination cursors.** Most return a top-N with no way to walk the
  full result set.
- **Completeness signals.** No way to distinguish "that is everything" from
  "that is the first page".
- **Raw fidelity.** Tools frequently summarise or reformat for agent
  consumption, which is exactly the lossy transformation ingestion must avoid —
  the index needs the source bytes, not a helpful rendering of them.
- **Version tokens.** Needed for out-of-order write protection
  ([04](../04-ingestion-and-delta.md) §3.4).
- **Permission data.** No MCP tool exposes the ACL feed the platform requires.

### Throughput and transport

stdio MCP servers spawn per client and serialise over a pipe. Backfilling two
million documents through one is slow in a way that no amount of tuning fixes.
Connectors calling the REST API directly can batch, parallelise within an agreed
rate budget, use conditional requests, and handle 429s with source-appropriate
backoff.

### The division of labour is the actual insight

| Question | Answered by |
|---|---|
| Where is the thing? | **Index** — `search_docs`, ranked, cheap, ACL-filtered |
| What did it say? | **Index** — `get_doc`, windowed |
| What is true *right now*? | **Live MCP tool** — current status, latest build, log lines |
| Change something | **Live MCP tool** — the write path, where the audit trail already exists |

The index provides *findability*; the live tools provide *currency* and
*mutation*. Conflating them produces either a stale index treated as
authoritative, or a live-query system that cannot rank across sources — and both
failures are worse than either system alone.

### They coexist rather than compete

Nothing about the existing tools changes. They register alongside the index's
MCP server; a consuming agent uses both. The index returns an identifier and a
staleness stamp, and the agent escalates to the live tool when the staleness
matters. This is a better outcome for the existing tools than replacing them,
and it is worth saying so to whoever built them.

---

## Consequences

**Accepted**
- Connector work is real work, not reuse. Six connectors against REST APIs,
  each with pagination, retry and rate-limit handling.
- Credentials must be configured twice — once for the live tools, once for
  ingestion. In platform mode these differ anyway: personal PATs for live
  tools, a read-only service account for ingestion.

**Mitigated**
- The Source Feed Contract keeps connectors small and uniform
  ([ADR-0003](0003-source-feed-contract.md)).
- **Where an existing MCP tool does expose list-plus-since semantics with
  cursors, wrapping it as a feed is legitimate** and saves the work. Check each
  tool against the contract rather than assuming either way — this is a
  per-tool question with a factual answer.

**Enabled**
- Ingestion throughput bounded by an agreed source rate budget, not by a pipe
- Raw source fidelity preserved
- The ACL feed becomes possible at all
- Live tools keep their job, and the write path keeps its existing audit trail
