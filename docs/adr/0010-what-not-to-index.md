# ADR-0010 — Logs, metrics and dashboards are referenced, not indexed

**Status**: Proposed · **Date**: 2026-08-11

---

## Context

Log and metric access is available via MCP tools, and the brief lists logs and
Grafana among the sources. `eil` exposes a `fetch_logs` tool as a capped,
audited read path.

The question is not whether to *reach* log data. It is whether log data belongs
in the index.

---

## Decision

**Do not index log lines or metric series. Index their *definitions* —
dashboards, panels, alert rules, saved queries, runbook links, incident
timelines. Fetch actual log lines live, on demand.**

Applies equally to: CI build logs, application logs, metric series, trace spans,
and raw monitoring output.

---

## Rationale

### Volume dwarfs everything else

A single moderately busy service can produce more log lines per day than the
entire Confluence corpus contains words. Indexing logs does not add a source to
this platform; it replaces the platform with a log platform, and a worse one
than the log platform that already exists.

### The value density is wrong

The value of a log line is almost entirely in its *neighbours* and its
*timestamp*. Retrieved as an isolated ranked chunk, stripped of surrounding
context, it is close to meaningless. Search ranking is the wrong access pattern
for time-series data — the right one is "show me everything in this window
around this event", which is what log tools already do well.

### It is stale on arrival

Logs are useful in the minutes after they are written. Any ingestion pipeline
with a five-minute cycle is too slow to be the primary access path, and one fast
enough would dominate the system's entire capacity.

### What *is* worth indexing is the durable part

The things that persist and that people genuinely cannot find:

| Indexed | Why |
|---|---|
| Dashboard and panel definitions | *"Which dashboard shows payment retry rates?"* is a real, frequently-failed question |
| Alert rules and thresholds | *"What alerts on retry exhaustion, and at what threshold?"* |
| Saved queries | Institutional knowledge about how to interrogate the system |
| Runbook links from alerts | The connective tissue between an alert and the response |
| Incident timelines and post-mortems | High-value prose, already durable |

These are small, slow-changing, high-value, and they connect the observability
world to the document link graph — which is what makes incident-context
assembly work: the index finds the runbook and the dashboard, and the live tool
reads the current numbers.

### The division of labour

`fetch_logs` remains as the live escalation path — capped and audited. The index
tells you *which* logs to look at and *which* dashboard shows the metric; the
live tool retrieves them. Same split as
[ADR-0008](0008-mcp-tools-are-escalation-not-ingestion.md).

---

## Also not indexed

| Excluded | Why |
|---|---|
| Binary artefacts, build outputs, `node_modules`, lockfiles | No retrieval value; large |
| Generated code and generated documentation | Duplicates the source, dilutes ranking |
| Full repository history | Index the current tree. History is reachable through Bitbucket, and indexing it makes long-removed secrets *searchable* ([05](../05-acl-and-security.md) §7) |
| Personal drafts and scratch spaces | Low value, high ACL sensitivity |
| Archived Confluence spaces | Index selectively, and stamp `valid_to` when ingested |
| Automated Jira comments (bot transitions) | Volume without meaning; dilutes real discussion |
| Email and chat | Out of scope; different permission model, different retention obligations, different consent posture |

Repository history deserves emphasis: indexing every commit turns a credential
that was removed three years ago into a ranked, searchable result. Index the
current tree.

---

## Consequences

**Accepted**
- *"Find the log line where this error first appeared"* is not answerable from
  the index. It is answerable by the live tool, which is the right place, and
  consumers must be told this rather than left to discover it.
- A Grafana connector becomes small and metadata-only.
- Someone will ask for log indexing. The answer is a capacity estimate: log
  volume against the ~105 GB the rest of the corpus occupies
  ([07](../07-scale-and-capacity.md)).

**Preserved**
- The corpus stays a size a single Postgres serves well
- Retrieval quality is not diluted by high-volume, low-value chunks — every
  irrelevant chunk is a chance to outrank a relevant one, and BM25's length
  normalisation is distorted by a corpus dominated by log lines
- Incident workflows still work, via index-for-definitions plus live-for-data
