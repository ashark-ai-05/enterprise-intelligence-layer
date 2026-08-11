#!/usr/bin/env node
/**
 * Zero-dependency corporate environment probe.
 *
 * Runs with **no install** — no pnpm, no npm, no node_modules. Node builtins
 * only. That matters because the first thing a locked-down machine breaks is
 * the package manager, and the facts below are needed *before* anything can be
 * installed.
 *
 *   node scripts/probe.mjs
 *
 * Set whichever of these are known; anything unset is skipped, never guessed:
 *
 *   EIL_CONFLUENCE_URL   EIL_JIRA_URL   EIL_BITBUCKET_URL
 *   EIL_MAAS_URL         EIL_MAAS_TOKEN EIL_MAAS_MODEL
 *   EIL_NPM_REGISTRY
 *
 * Proxy note: Node's global fetch ignores HTTPS_PROXY unless told otherwise.
 * This probe re-executes itself with NODE_USE_ENV_PROXY=1 when a proxy is
 * configured, so what it measures is the path a real client would take.
 */

const TIMEOUT_MS = 10_000;

const env = process.env;
const proxy = env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY ?? "";
const proxyConfigured = proxy.trim() !== "";

// Re-exec once with the proxy flag set, so measurements reflect the real route.
if (proxyConfigured && env.NODE_USE_ENV_PROXY !== "1" && env.EIL_PROBE_REEXEC !== "1") {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...env, NODE_USE_ENV_PROXY: "1", EIL_PROBE_REEXEC: "1" },
  });
  process.exit(result.status ?? 1);
}

const results = [];
const record = (status, title, evidence, implication) =>
  results.push({ status, title, evidence, implication });

// ── runtime ──────────────────────────────────────────────────────────────────
const major = Number(process.versions.node.split(".")[0]);
record(
  major >= 22 ? "pass" : "fail",
  "Node.js 22 or newer",
  `process.version = ${process.version}`,
  major >= 22 ? undefined : "The platform requires Node 22+. Nothing below depends on this being fixed first.",
);

record(
  "pass",
  "Native proxy support",
  major >= 24
    ? "Node 24+: NODE_USE_ENV_PROXY=1 makes fetch honour HTTPS_PROXY"
    : `Node ${major}: no native proxy support; the app installs undici's ProxyAgent instead`,
);

// ── proxy configuration ──────────────────────────────────────────────────────
record(
  proxyConfigured ? "pass" : "skip",
  "Proxy environment",
  proxyConfigured ? `proxy = ${proxy}` : "No HTTPS_PROXY / HTTP_PROXY set",
  proxyConfigured
    ? undefined
    : "Either this machine has direct egress, or the proxy is configured somewhere this process cannot see. Confirm which — it changes every connector.",
);

const noProxy = env.no_proxy ?? env.NO_PROXY ?? "";
record(
  "pass",
  "NO_PROXY",
  noProxy.trim() === "" ? "unset — every host would go through the proxy" : noProxy,
);

record(
  env.NODE_EXTRA_CA_CERTS ? "pass" : "skip",
  "Corporate TLS bundle",
  env.NODE_EXTRA_CA_CERTS ?? "NODE_EXTRA_CA_CERTS unset",
  env.NODE_EXTRA_CA_CERTS
    ? undefined
    : "If the proxy intercepts TLS, every HTTPS request fails with a self-signed-certificate error until this is set.",
);

// ── reachability ─────────────────────────────────────────────────────────────
async function probe(url, init = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: true, status: response.status, ms: Date.now() - started };
  } catch (error) {
    const cause = error?.cause?.code ?? error?.name ?? "unknown";
    return { ok: false, error: `${cause}: ${error?.message ?? error}`, ms: Date.now() - started };
  }
}

const targets = [
  ["Confluence", env.EIL_CONFLUENCE_URL],
  ["Jira", env.EIL_JIRA_URL],
  ["Bitbucket", env.EIL_BITBUCKET_URL],
  ["npm registry", env.EIL_NPM_REGISTRY],
];

for (const [label, url] of targets) {
  if (!url || url.trim() === "") {
    record("skip", `${label} reachable`, "not configured");
    continue;
  }
  const result = await probe(url, { method: "GET", redirect: "manual" });
  if (result.ok) {
    record(
      "pass",
      `${label} reachable`,
      `${url} → HTTP ${result.status} in ${result.ms}ms`,
      result.status === 401 || result.status === 403
        ? "Connectivity confirmed; this status is about credentials, not the network."
        : undefined,
    );
  } else {
    record(
      "fail",
      `${label} reachable`,
      `${url} failed after ${result.ms}ms — ${result.error}`,
      result.ms >= TIMEOUT_MS - 500
        ? "A timeout here is the classic missing-proxy symptom, not a slow source."
        : "Check DNS, credentials and the proxy allowlist for this host.",
    );
  }
}

// ── MaaS embeddings ──────────────────────────────────────────────────────────
const maas = env.EIL_MAAS_URL;
if (!maas || maas.trim() === "") {
  record(
    "skip",
    "MaaS serves embeddings",
    "EIL_MAAS_URL not set",
    "Until this is known, bulk embedding stays local — content never leaves the process.",
  );
} else {
  const result = await probe(`${maas.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.EIL_MAAS_TOKEN ? { authorization: `Bearer ${env.EIL_MAAS_TOKEN}` } : {}),
    },
    body: JSON.stringify({ input: "eil probe", ...(env.EIL_MAAS_MODEL ? { model: env.EIL_MAAS_MODEL } : {}) }),
  });
  record(
    result.ok && result.status === 200 ? "pass" : "fail",
    "MaaS serves embeddings",
    result.ok ? `POST ${maas}/embeddings → HTTP ${result.status} in ${result.ms}ms` : `failed — ${result.error}`,
    result.ok && result.status === 200
      ? "Usable for query-time embedding. Bulk embedding still stays local."
      : "No embeddings endpoint. Semantic search uses the vendored local model instead.",
  );
}

// ── report ───────────────────────────────────────────────────────────────────
const symbol = { pass: "✓", fail: "✗", skip: "–" };
const width = Math.max(...results.map((r) => r.title.length));

process.stdout.write("\n");
for (const r of results) {
  process.stdout.write(`${symbol[r.status]} ${r.title.padEnd(width)}  ${r.evidence}\n`);
  if (r.implication) process.stdout.write(`  ${" ".repeat(width)}  → ${r.implication}\n`);
}

const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
process.stdout.write(
  `\n${counts.pass ?? 0} passed, ${counts.fail ?? 0} failed, ${counts.skip ?? 0} skipped\n`,
);
process.stdout.write("A skip is an unknown, not a pass. Each one is a fact still worth establishing.\n");
process.exit((counts.fail ?? 0) > 0 ? 1 : 0);
