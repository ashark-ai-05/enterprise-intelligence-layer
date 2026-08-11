# 11 — Roadmap

Five phases with explicit exit gates. **The gates are the point.** A phase that
ships without meeting its gate does not advance the project; it moves the
unresolved risk somewhere more expensive.

Durations assume one to two engineers and are indicative.

---

## P0 — Personal utility (weeks 1–4)

**Goal**: one person can find things faster than they could before. No
infrastructure, no approvals, no procurement.

This is approximately what `eil` already is. Treat P0 as *hardening and
adoption*, not as building.

- Node + PGlite or local Postgres. No admin rights required.
- Confluence + Jira + one repository, personal credentials.
- Lexical arms only. No embeddings yet.
- MCP stdio, wired into Copilot and Amp.
- **Proxy hardening** — `ProxyAgent` as global dispatcher, `NO_PROXY` honoured,
  `NODE_EXTRA_CA_CERTS`, internal npm registry verified for every dependency.
  → [ADR-0009](adr/0009-proxy-and-no-install-runtime.md)
- **Evaluation harness with 50 synthetic queries.** Build it now, while it is
  cheap and there is nothing to regress.

**Exit gate**
- [ ] 5 users, daily usage, unprompted
- [ ] Recall@10 > 0.70 on the synthetic set
- [ ] Delta sync efficiency: `fetched / seen` < 0.1 in steady state
- [ ] Every dependency confirmed present in the internal registry
- [ ] Zero native build steps in the dependency tree

---

## P1 — Semantic and measurable (weeks 5–10)

**Goal**: hybrid retrieval that is demonstrably better than lexical alone.

- Local ONNX embeddings, vendored model, WASM runtime fallback if
  `onnxruntime-node` is blocked. → [ADR-0005](adr/0005-local-first-embeddings.md)
- Vector funnel: signatures, IVF centroids, calibrated `nprobe`, mandatory exact
  rescore.
- RRF fusion across five arms.
- **BM25 activated — but only after the eval gate exists.**
- Golden set to 300 pairs; regression gate wired into CI.
- Two-hash change detection. → [ADR-0004](adr/0004-two-hash-change-detection.md)
- Per-type chunking: Jira thread-aware, code symbol-aware.

**Exit gate**
- [ ] Recall@10 > 0.80; hybrid beats lexical-only by ≥ 10 points
- [ ] Vector recall vs exact > 0.95 on a sample
- [ ] p95 < 300 ms without rerank
- [ ] CI blocks a deliberately-introduced ranking regression
- [ ] A page re-parent is detected and its ACEs updated (test, not hope)

---

## P2 — Platform mode (weeks 11–20)

**The hard phase.** Everything before this is a personal tool; this is where it
becomes something the organisation depends on, and where it can leak.

- Provisioned org Postgres. Read replicas.
- Service-account ingestion, read-only.
- **ACL mirroring**: principal graph, ALLOW/DENY ACEs, deny-wins, container
  ACLs. → [05](05-acl-and-security.md)
- **Query-time group resolution** from the directory, 5-minute TTL.
- Separate ACL sync lane with a 15-minute SLA and nightly reconcile.
- OIDC identity; per-request `Viewer`; local-viewer path removed from the
  platform code path entirely.
- MCP over HTTP + REST.
- Secret and PII scanning with quarantine and a review queue.
- Audit log with `doc_ids`, partitioned, retained.
- Red-team ACL suite extended to platform-mode cases.

**Exit gate — none of these are negotiable**
- [ ] Security review passed
- [ ] ACL red-team suite green, including: service-account-ingested document
      invisible to an unrelated user; re-parent under restriction; departed
      user's group expansion empty within TTL; graph expansion to a restricted
      neighbour blocked
- [ ] ACL sync lag < 15 min at p99, alerting live
- [ ] Fail-closed invariant proven by test: a document with empty `acl_allow`
      returns to nobody
- [ ] Audit log answers "who saw document Y" without new engineering
- [ ] 50 pilot users across at least three teams

---

## P3 — Breadth and quality (weeks 21–32)

**Goal**: more sources, better answers, self-service.

- PDF and attachment ingestion via `pdf.js`; explicit `extraction: none` for
  scanned documents rather than silent garbage.
- Filesystem and notes connectors.
- Grafana and log **definitions** — dashboards, alert rules, saved queries,
  runbook links. Not log lines. → [ADR-0010](adr/0010-what-not-to-index.md)
- Optional cross-encoder reranking, opt-in per call.
- Reporting views and a documentation-health dashboard.
- Self-service container onboarding: a team can request its space be indexed.
- Zero-result review feeding the indexing backlog.

**Exit gate**
- [ ] Recall@10 > 0.85 sustained at 10× the P1 corpus
- [ ] 500 users; > 30% weekly active among onboarded teams
- [ ] Reporting served from a replica; primary untouched by BI
- [ ] Reporting ACL posture decided and documented

---

## P4 — Applications (ongoing)

Once retrieval is trustworthy, applications are cheap — none of them brings its
own connectors, index, permissions or audit.

- Ask-anything agent
- Incident-context assembly (index finds the runbook, live tools read the state)
- Code review context
- Onboarding assistant scoped to a team's containers
- Documentation health and duplicate detection
- Requirements/evidence gating — `eil` already has a working version of this
  and it is a genuinely differentiated capability worth carrying forward

---

## Sequencing rules

1. **The evaluation harness precedes every ranking change.** Including BM25.
   This is the rule most likely to be skipped and most expensive to skip.
2. **ACL mirroring precedes shared serving.** No pilot users on a shared index
   before the red-team suite is green. Not "mostly green".
3. **Proxy and registry verification precede everything.** A dependency that is
   not in the internal mirror does not exist, and discovering that in week 9 is
   avoidable in week 1.
4. **Personal mode is never deprecated.** It is the adoption funnel, the
   development environment, and the fallback when the platform is down.
5. **Ingest breadth follows demonstrated demand.** Zero-result analysis is a
   better prioritisation signal than a stakeholder's list.

---

## What to do first, concretely

If only one week is available:

1. Verify every intended dependency resolves through the internal registry, and
   that a proxy-dispatched request to Confluence and Jira actually succeeds from
   the target machine. **This is the highest-variance unknown in the plan** —
   everything else is engineering, and this is either fine or a project-shaping
   obstacle, and you cannot tell which without trying it.
2. Generate 50 synthetic golden queries from a corpus sample.
3. Run `eil` as-is against one Confluence space and one Jira project, and
   measure recall on those 50.

That week converts three assumptions into facts, and each of them can invalidate
a phase.
