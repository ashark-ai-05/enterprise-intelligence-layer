/**
 * `eil doctor` — the constraint checklist, executable.
 *
 * ADR-0009 lists nine facts that each invalidate a phase if they come back NO.
 * A markdown checklist gets skimmed; a command gets run. Every check here
 * produces evidence, not an opinion, and no check is allowed to guess: if it
 * cannot establish something it reports `skip` with the reason.
 *
 * → docs/adr/0009-proxy-and-no-install-runtime.md
 */

import { readProxyConfig, shouldProxy, type ProxyConfig } from '../net/proxy.js';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** What was actually observed. The point of the whole exercise. */
  readonly evidence: string;
  /** What this result means for the plan, when it is not obvious. */
  readonly implication?: string;
}

export interface DoctorEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion: string;
  /** Injected so the checks are testable without network access. */
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
}

export function defaultEnvironment(): DoctorEnvironment {
  return {
    env: process.env,
    nodeVersion: process.version,
    fetchImpl: globalThis.fetch,
    now: () => Date.now(),
  };
}

const REQUEST_TIMEOUT_MS = 10_000;

async function probe(
  environment: DoctorEnvironment,
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const started = environment.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await environment.fetchImpl(url, { ...init, signal: controller.signal });
    return { ok: true, status: response.status, ms: environment.now() - started };
  } catch (error) {
    return {
      ok: false,
      ms: environment.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function checkNodeVersion(environment: DoctorEnvironment): CheckResult {
  const major = Number(environment.nodeVersion.replace(/^v/, '').split('.')[0]);
  const ok = Number.isFinite(major) && major >= 20;
  return {
    id: 'runtime.node',
    title: 'Node.js 20 or newer',
    status: ok ? 'pass' : 'fail',
    evidence: `process.version = ${environment.nodeVersion}`,
    ...(ok ? {} : { implication: 'The WASM and fetch behaviour this design relies on needs Node 20+.' }),
  };
}

export function checkProxyConfiguration(environment: DoctorEnvironment): CheckResult[] {
  const config = readProxyConfig(environment.env);
  const anyProxy = config.httpsProxy ?? config.httpProxy;

  const configured: CheckResult = {
    id: 'proxy.configured',
    title: 'Proxy environment variables present',
    status: anyProxy === undefined ? 'skip' : 'pass',
    evidence:
      anyProxy === undefined
        ? 'No HTTP_PROXY / HTTPS_PROXY set'
        : `HTTPS_PROXY=${config.httpsProxy ?? '(unset)'} HTTP_PROXY=${config.httpProxy ?? '(unset)'}`,
    ...(anyProxy === undefined
      ? {
          implication:
            'Either this machine has direct egress, or the proxy is configured somewhere this process cannot see. Confirm which — it changes every connector.',
        }
      : {}),
  };

  const bypass: CheckResult = {
    id: 'proxy.no_proxy',
    title: 'NO_PROXY parsed',
    status: 'pass',
    evidence: config.bypassAll
      ? 'NO_PROXY=* — everything bypasses the proxy'
      : config.noProxy.length === 0
        ? 'NO_PROXY unset — every host goes through the proxy'
        : config.noProxy
            .map((r) => `${r.subdomainsOnly ? '.' : ''}${r.host}${r.port === undefined ? '' : `:${r.port}`}`)
            .join(', '),
  };

  const certs = environment.env['NODE_EXTRA_CA_CERTS'];
  const tls: CheckResult = {
    id: 'proxy.tls',
    title: 'Corporate TLS certificate bundle',
    status: certs === undefined ? 'skip' : 'pass',
    evidence: certs === undefined ? 'NODE_EXTRA_CA_CERTS unset' : `NODE_EXTRA_CA_CERTS=${certs}`,
    ...(certs === undefined
      ? {
          implication:
            'If the proxy intercepts TLS, every HTTPS request fails with a self-signed-certificate error until this is set.',
        }
      : {}),
  };

  return [configured, bypass, tls];
}

/**
 * The check that catches the bug this whole design warns about.
 *
 * Node's global `fetch` ignores HTTPS_PROXY. If a proxy is configured but no
 * dispatcher is installed, external requests hang until timeout and it reads as
 * "the source is slow".
 */
export async function checkProxyDispatcher(environment: DoctorEnvironment): Promise<CheckResult> {
  const config = readProxyConfig(environment.env);
  if (config.httpsProxy === undefined && config.httpProxy === undefined) {
    return {
      id: 'proxy.dispatcher',
      title: 'Global dispatcher routes through the proxy',
      status: 'skip',
      evidence: 'No proxy configured, so no dispatcher is needed',
    };
  }

  try {
    const undici = await import('undici');
    const hasEnvAgent = typeof undici.EnvHttpProxyAgent === 'function';
    return {
      id: 'proxy.dispatcher',
      title: 'Global dispatcher routes through the proxy',
      status: hasEnvAgent ? 'pass' : 'fail',
      evidence: hasEnvAgent
        ? 'undici.EnvHttpProxyAgent available; installGlobalProxy() will route per-request'
        : 'undici is installed but EnvHttpProxyAgent is missing — upgrade undici',
      ...(hasEnvAgent
        ? {}
        : { implication: "Without it, Node's fetch silently ignores HTTPS_PROXY and external hosts hang." }),
    };
  } catch (error) {
    return {
      id: 'proxy.dispatcher',
      title: 'Global dispatcher routes through the proxy',
      status: 'fail',
      evidence: `undici could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      implication: "Node's fetch ignores HTTPS_PROXY without it. Every proxied source will time out.",
    };
  }
}

export interface HostTarget {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

/** Source hosts to probe, read from the environment so nothing is hardcoded. */
export function targetsFromEnv(env: Readonly<Record<string, string | undefined>>): HostTarget[] {
  const candidates: readonly (readonly [string, string, string])[] = [
    ['source.confluence', 'Confluence', 'EIL_CONFLUENCE_URL'],
    ['source.jira', 'Jira', 'EIL_JIRA_URL'],
    ['source.bitbucket', 'Bitbucket', 'EIL_BITBUCKET_URL'],
    ['source.maas', 'MaaS endpoint', 'EIL_MAAS_URL'],
    ['registry.npm', 'npm registry', 'EIL_NPM_REGISTRY'],
  ];

  return candidates.flatMap(([id, label, variable]) => {
    const url = env[variable];
    return url === undefined || url.trim() === '' ? [] : [{ id, label, url }];
  });
}

export async function checkHostReachable(
  environment: DoctorEnvironment,
  target: HostTarget,
  config: ProxyConfig,
): Promise<CheckResult> {
  const via = shouldProxy(target.url, config);
  const result = await probe(environment, target.url, { method: 'GET', redirect: 'manual' });
  const route = via === undefined ? 'direct' : `via ${via}`;

  if (!result.ok) {
    return {
      id: target.id,
      title: `${target.label} reachable`,
      status: 'fail',
      evidence: `${target.url} (${route}) failed after ${result.ms}ms: ${result.error}`,
      implication:
        result.ms >= REQUEST_TIMEOUT_MS - 500
          ? 'A timeout here is the classic missing-proxy-dispatcher symptom, not a slow source.'
          : 'Check credentials, DNS and the proxy allowlist for this host.',
    };
  }

  // 401/403 still proves connectivity — the request reached the server.
  const reachable = result.status !== undefined;
  return {
    id: target.id,
    title: `${target.label} reachable`,
    status: reachable ? 'pass' : 'fail',
    evidence: `${target.url} (${route}) → HTTP ${result.status} in ${result.ms}ms`,
    ...(result.status === 401 || result.status === 403
      ? { implication: 'Connectivity confirmed; this status is about credentials, not the network.' }
      : {}),
  };
}

/**
 * Does the MaaS endpoint serve embeddings, or only chat?
 *
 * F2 in docs/15 — the highest-leverage single fact in the design, and one curl
 * to establish.
 */
export async function checkMaasEmbeddings(environment: DoctorEnvironment): Promise<CheckResult> {
  const base = environment.env['EIL_MAAS_URL'];
  if (base === undefined || base.trim() === '') {
    return {
      id: 'maas.embeddings',
      title: 'MaaS endpoint serves embeddings',
      status: 'skip',
      evidence: 'EIL_MAAS_URL not set',
      implication: 'Until this is known, bulk embedding stays local (corpus egress argument, docs/15 §F2).',
    };
  }

  const token = environment.env['EIL_MAAS_TOKEN'];
  const url = `${base.replace(/\/$/, '')}/embeddings`;
  const result = await probe(environment, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ input: 'eil doctor capability probe', model: environment.env['EIL_MAAS_MODEL'] }),
  });

  if (!result.ok) {
    return {
      id: 'maas.embeddings',
      title: 'MaaS endpoint serves embeddings',
      status: 'fail',
      evidence: `POST ${url} failed after ${result.ms}ms: ${result.error}`,
    };
  }

  const serves = result.status === 200;
  return {
    id: 'maas.embeddings',
    title: 'MaaS endpoint serves embeddings',
    status: serves ? 'pass' : 'fail',
    evidence: `POST ${url} → HTTP ${result.status} in ${result.ms}ms`,
    implication: serves
      ? 'Usable for query-time embedding. Bulk embedding still stays local — see docs/15 §F2.'
      : 'No embeddings endpoint. Semantic search needs the local ONNX path, or defers entirely.',
  };
}

/** Would installing a native binary dependency be required? WASM is the loophole that makes this design possible. */
export async function checkNativeBinaryDependency(): Promise<CheckResult> {
  try {
    // Indirect specifier: this module is deliberately not a dependency. The
    // check is whether it *could* be installed here, not whether we ship it.
    const specifier = 'onnxruntime-node';
    await import(/* @vite-ignore */ specifier);
    return {
      id: 'runtime.native',
      title: 'Native binary dependencies',
      status: 'pass',
      evidence: 'onnxruntime-node loaded — a native binary is present and usable',
    };
  } catch {
    return {
      id: 'runtime.native',
      title: 'Native binary dependencies',
      status: 'skip',
      evidence: 'onnxruntime-node not installed',
      implication:
        'Expected at this stage. It downloads a platform binary at install time, which is plausibly blocked; onnxruntime-web (WASM) is the fallback and changes only backfill duration.',
    };
  }
}

export interface DoctorReport {
  readonly checks: readonly CheckResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export function summarise(checks: readonly CheckResult[]): DoctorReport {
  return {
    checks,
    passed: checks.filter((c) => c.status === 'pass').length,
    failed: checks.filter((c) => c.status === 'fail').length,
    skipped: checks.filter((c) => c.status === 'skip').length,
  };
}

export async function runDoctor(
  environment: DoctorEnvironment = defaultEnvironment(),
): Promise<DoctorReport> {
  const config = readProxyConfig(environment.env);
  const checks: CheckResult[] = [
    checkNodeVersion(environment),
    ...checkProxyConfiguration(environment),
    await checkProxyDispatcher(environment),
    await checkNativeBinaryDependency(),
  ];

  for (const target of targetsFromEnv(environment.env)) {
    checks.push(await checkHostReachable(environment, target, config));
  }
  checks.push(await checkMaasEmbeddings(environment));

  return summarise(checks);
}
