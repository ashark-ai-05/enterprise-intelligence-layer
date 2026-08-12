# Enterprise Intelligence Layer

A local-first, governed search and retrieval platform for selected Confluence,
Jira, Git/Bitbucket, and file content. It provides scope-driven incremental
ingestion, fail-closed ACL enforcement, lexical and graph retrieval, offline
embeddings, and an MCP interface.

The repository currently runs end to end on deterministic source fixtures.
Live ingestion connectors are the next integration step.

## Requirements

- Node.js 22 or newer
- pnpm 10.32.1 (pinned by `packageManager`)
- no database server, model download, credentials, or admin installation for
  the local demo

## Run the self-contained demo

```bash
git clone https://github.com/ashark-ai-05/enterprise-intelligence-layer.git
cd enterprise-intelligence-layer
pnpm install --frozen-lockfile
pnpm demo
```

The demo creates a temporary embedded PGlite database, generates roughly 300
mock Confluence/Jira/Git objects, and runs the real ingestion, ACL, indexing,
retrieval, and MCP tool paths. For a larger generated corpus:

```bash
pnpm demo:stress
```

Run the full acceptance suite:

```bash
pnpm check
```

## Ingest and retrieve data

### Runnable now: generated Confluence, Jira, and code

The current ingestion connectors are deterministic fixtures. This command
generates and ingests all three source types, publishes their indexes, then
runs cross-source search and evidence retrieval through the real MCP tool
implementation:

```bash
pnpm demo
```

Use the larger generated corpus when testing throughput and reconciliation:

```bash
pnpm demo:stress
```

Look for these sections in the output:

```text
Synthetic corpus        Confluence + Jira + Git ingestion counters
Evaluation              retrieval measurements
MCP tool surface        search_enterprise + get_evidence results
```

### Query a populated local database over MCP

Build the project, then send newline-delimited JSON-RPC messages to the stdio
server. The server uses `EIL_DATA_DIR` (default `.eil/data`) or `DATABASE_URL`.

```bash
pnpm build

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_enterprise","arguments":{"query":"payment retry policy"}}}' \
  | node dist/cli.js serve
```

Fetch the full authorized evidence for an ID returned by search:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_evidence","arguments":{"id":"PAY-1","maxBytes":8000}}}' \
  | node dist/cli.js serve
```

For normal use, configure the stdio command in an MCP-capable client instead
of typing JSON-RPC manually:

```text
command: node
args:    /absolute/path/to/enterprise-intelligence-layer/dist/cli.js serve
```

### Live enterprise ingestion status

There is not yet a supported CLI command that ingests live Confluence, Jira,
or Bitbucket data. The source URL variables used by `pnpm doctor` only test
connectivity; they do not ingest content. Do not treat commands such as
`eil ingest confluence` as available—they have not been implemented.

Live commands will be documented here only after the connector can fetch
authoritative content and ACLs and has passed delta, deletion, permission-change,
proxy, rate-limit, and replay acceptance tests. The intended scope shapes are:

```text
Confluence: exact page URL/ID, page subtree, or selected space
Jira:       exact issue key, saved filter, or selected project
Code:       selected repository, refs, include paths, and exclude paths
```

## Corporate-machine checks

### Fastest path: no install required

If the package manager is broken — which is the first thing a locked-down image
tends to break — this still runs. Node builtins only: no pnpm, no npm, no
`node_modules`.

```bash
git clone https://github.com/ashark-ai-05/enterprise-intelligence-layer.git
cd enterprise-intelligence-layer

EIL_CONFLUENCE_URL="https://confluence.example.corp" \
EIL_JIRA_URL="https://jira.example.corp" \
EIL_MAAS_URL="https://models.example.corp" \
  node scripts/probe.mjs
```

It reports the same facts as `pnpm doctor` — runtime, proxy, TLS bundle, source
reachability, whether the model endpoint serves embeddings — treats a skip as an
unknown rather than a pass, and exits non-zero on failure.

**On the proxy specifically**, it measures the path a real client takes rather
than one nothing uses. Node's global `fetch` ignores `HTTPS_PROXY` unless told
otherwise; measured on Node 24:

| | result |
|---|---|
| `HTTPS_PROXY` alone | request goes **direct**, proxy silently ignored |
| `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` | routed through the proxy |

The probe sets that flag itself. Where a proxy is mandatory, the first form does
not error — it hangs until timeout and reads as "the source is slow".

### Toolchain diagnostics

First confirm the managed Node/npm/pnpm toolchain. These commands do not print
registry tokens or proxy passwords:

```bash
node --version
npm --version
pnpm --version
node -p "process.execPath"
npm config get prefix
npm config get userconfig
```

Do not share `npm config list` or the contents of `.npmrc`; they may contain
credentials.

Install and run the environment checks:

```bash
pnpm install --frozen-lockfile
pnpm doctor
```

If pnpm reports `Failed to load npm builtin configs`, capture the complete
error and the safe version/config outputs above. The failure happens before
EIL starts and normally indicates a broken/missing npm installation, a global
pnpm shim problem, or an unreadable corporate npm configuration. Try the
same version through Corepack only if Corepack is already approved and cached:

```bash
corepack pnpm --version
corepack pnpm doctor
```

Corepack may otherwise need network access and a writable cache, so it is a
diagnostic alternative rather than a prerequisite. Do not change corporate npm
settings without the complete error and guidance from the platform owner.

If dependencies are installed and `dist/` already exists, bypass pnpm and run
the EIL checks directly:

```bash
node dist/cli.js doctor
```

To probe approved endpoints, set only the URLs available in your environment:

```bash
EIL_CONFLUENCE_URL="https://confluence.example.corp" \
EIL_JIRA_URL="https://jira.example.corp" \
EIL_BITBUCKET_URL="https://bitbucket.example.corp" \
EIL_MAAS_URL="https://models.example.corp" \
pnpm doctor
```

For an intercepting corporate proxy, configure the standard proxy variables
and the approved CA bundle. Never commit these values:

```bash
HTTPS_PROXY="http://proxy.example.corp:8080" \
NO_PROXY="localhost,127.0.0.1,.example.corp" \
NODE_EXTRA_CA_CERTS="/approved/path/corporate-ca.pem" \
pnpm doctor
```

The doctor reports skipped checks as unknown, not passed. Share its output only
after removing internal hostnames if required by company policy.

## Run the MCP server

Build, then start MCP over stdio:

```bash
pnpm build
node dist/cli.js serve
```

Available read-only tools:

- `search_enterprise`
- `get_evidence`
- `list_containers`
- `get_freshness`

The current stdio identity model is for personal/local use. Do not expose it as
a shared service; shared deployment requires caller-derived enterprise identity
instead of the local process identity.

## Storage profiles

PGlite is the default local database. To use hosted PostgreSQL, set
`DATABASE_URL` before running commands:

```bash
DATABASE_URL="postgresql://user@host/database" pnpm demo
```

Use a secret manager or local environment injection for real credentials. Do
not commit connection strings.

## Current capabilities

- explicit page/space, issue/project, repository/path, and file scopes
- incremental content, metadata, and ACL change detection
- bounded reconciliation, tombstones, retention, and legal holds
- durable fenced jobs, retries, checkpoints, DLQ, scheduling, and rate budgets
- container/resource/chunk ACLs with deny-wins and fail-closed identity mapping
- extension-free PostgreSQL lexical search and persisted relationship expansion
- vendored offline MiniLM WASM embeddings with versioned vector storage
- deterministic synthetic corpora, ACL adversarial cases, and CI regression gates
- MCP search/evidence/freshness tools with permission re-checks

Search metrics printed by the demo validate deterministic fixture capabilities;
they are not claims about production relevance. Real relevance evaluation must
use representative corporate queries and independently judged evidence.

## Documentation

- [System architecture](docs/02-architecture.md)
- [Ingestion and delta handling](docs/04-ingestion-and-delta.md)
- [ACL and security](docs/05-acl-and-security.md)
- [Retrieval](docs/06-retrieval.md)
- [Evaluation](docs/09-evaluation.md)
- [Operations](docs/10-operations.md)
- [Roadmap](docs/11-roadmap.md)
- [System diagram and technology choices](docs/13-system-diagram-and-tech-stack.md)
- [Open questions and delivery plan](docs/15-open-questions-and-delivery-plan.md)
- [Scoped ingestion and storage profiles](docs/16-scoped-ingestion-and-storage-profiles.md)

Architecture decisions are in [`docs/adr/`](docs/adr/).

## Security

Retrieved enterprise content is untrusted input. Authorization is enforced
before retrieval and again before evidence serialization. Do not combine
retrieved content with write-capable tools without an explicit human approval
step. Report security issues privately to the repository owner rather than in a
public issue.

## License

Apache-2.0. The vendored embedding model includes its own notice and licensing
files under `models/`.
