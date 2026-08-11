/**
 * Corporate proxy egress.
 *
 * Node's global `fetch` (undici) does NOT honour `HTTPS_PROXY` / `HTTP_PROXY`.
 * Internal hosts work, proxied hosts hang until timeout, and the whole thing
 * reads as "Confluence is slow". A ProxyAgent must be installed explicitly as
 * the global dispatcher.
 *
 * This module is deliberately split in two:
 *   - `shouldProxy` and `parseNoProxy` are pure and exhaustively tested. NO_PROXY
 *     matching is where the real bugs live and it needs no network to verify.
 *   - `installGlobalProxy` is the thin imperative shell that loads undici.
 *
 * → docs/adr/0009-proxy-and-no-install-runtime.md
 */

export interface NoProxyRule {
  /** Hostname suffix to match, lower-cased, without a leading dot. */
  readonly host: string;
  /** Port constraint, or undefined to match any port. */
  readonly port?: number;
  /** True when the rule was written to match subdomains only (leading dot). */
  readonly subdomainsOnly: boolean;
}

export interface ProxyConfig {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy: readonly NoProxyRule[];
  /** `*` in NO_PROXY disables proxying entirely. */
  readonly bypassAll: boolean;
}

/**
 * Parse a NO_PROXY list.
 *
 * The de-facto format is a comma (or whitespace) separated list where each
 * entry is a hostname, a `.suffix`, a `host:port`, or `*`. There is no
 * standard, so this implements the intersection of what curl and the major
 * runtimes accept, and documents the choices rather than guessing silently.
 */
export function parseNoProxy(raw: string | undefined): { rules: NoProxyRule[]; bypassAll: boolean } {
  if (raw === undefined) return { rules: [], bypassAll: false };

  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.includes('*')) return { rules: [], bypassAll: true };

  const rules: NoProxyRule[] = [];
  for (const entry of entries) {
    // A leading dot means "subdomains of", e.g. `.corp.example` matches
    // `wiki.corp.example` but not bare `corp.example`.
    const subdomainsOnly = entry.startsWith('.');
    let host = subdomainsOnly ? entry.slice(1) : entry;
    let port: number | undefined;

    // `host:port`. IPv6 literals are bracketed, so a bare colon is unambiguous.
    const colon = host.lastIndexOf(':');
    if (colon > 0 && !host.includes(']')) {
      const maybePort = Number(host.slice(colon + 1));
      if (Number.isInteger(maybePort) && maybePort > 0 && maybePort <= 65535) {
        port = maybePort;
        host = host.slice(0, colon);
      }
    }

    // A leading `*.` is the other common spelling of `.suffix`.
    if (host.startsWith('*.')) {
      host = host.slice(2);
      rules.push({ host: host.toLowerCase(), subdomainsOnly: true, ...(port === undefined ? {} : { port }) });
      continue;
    }

    if (host.length === 0) continue;
    rules.push({ host: host.toLowerCase(), subdomainsOnly, ...(port === undefined ? {} : { port }) });
  }

  return { rules, bypassAll: false };
}

/** Read proxy configuration from an environment-like object. */
export function readProxyConfig(env: Readonly<Record<string, string | undefined>> = process.env): ProxyConfig {
  // An empty value means "no proxy", not "a proxy at the empty URL".
  // `HTTPS_PROXY=` is a common way to disable an inherited proxy, and treating
  // it as configured routes every request to nowhere.
  const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value;

  // Lower-case wins over upper-case: it is the more specific convention and
  // matches curl. `http_proxy` lower-case only is deliberate in curl to avoid
  // CGI header injection; we accept both but prefer lower.
  const httpProxy = nonEmpty(env['http_proxy']) ?? nonEmpty(env['HTTP_PROXY']);
  const httpsProxy = nonEmpty(env['https_proxy']) ?? nonEmpty(env['HTTPS_PROXY']);
  const { rules, bypassAll } = parseNoProxy(env['no_proxy'] ?? env['NO_PROXY']);

  return {
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    noProxy: rules,
    bypassAll,
  };
}

function defaultPortFor(protocol: string): number | undefined {
  if (protocol === 'https:') return 443;
  if (protocol === 'http:') return 80;
  return undefined;
}

/** Does this URL bypass the proxy under the given NO_PROXY rules? */
export function isBypassed(target: URL, config: ProxyConfig): boolean {
  if (config.bypassAll) return true;

  const host = target.hostname.toLowerCase();
  const port = target.port === '' ? defaultPortFor(target.protocol) : Number(target.port);

  return config.noProxy.some((rule) => {
    if (rule.port !== undefined && rule.port !== port) return false;
    if (rule.subdomainsOnly) return host.endsWith(`.${rule.host}`);
    return host === rule.host || host.endsWith(`.${rule.host}`);
  });
}

/**
 * Decide whether a request should go through a proxy, and which one.
 *
 * Returns the proxy URL, or `undefined` for a direct connection.
 */
export function shouldProxy(url: string | URL, config: ProxyConfig): string | undefined {
  const target = typeof url === 'string' ? new URL(url) : url;
  if (isBypassed(target, config)) return undefined;
  if (target.protocol === 'https:') return config.httpsProxy;
  if (target.protocol === 'http:') return config.httpProxy;
  return undefined;
}

export interface InstallResult {
  readonly installed: boolean;
  /** The proxy that was installed as the global dispatcher, if any. */
  readonly proxyUrl?: string;
  readonly reason: string;
}

/**
 * Install a proxy-aware global dispatcher for `fetch`.
 *
 * `EnvHttpProxyAgent` is undici's built-in agent that reads HTTP_PROXY,
 * HTTPS_PROXY and NO_PROXY and routes per request — which is what we want,
 * because a single ProxyAgent would send NO_PROXY hosts through the proxy too.
 *
 * Must be called once, at process start, before any request is made.
 */
export async function installGlobalProxy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallResult> {
  const config = readProxyConfig(env);
  const anyProxy = config.httpProxy ?? config.httpsProxy;

  if (anyProxy === undefined) {
    return { installed: false, reason: 'no HTTP_PROXY or HTTPS_PROXY set; using direct connections' };
  }

  const undici = await import('undici');
  const agent = new undici.EnvHttpProxyAgent();
  undici.setGlobalDispatcher(agent);

  return {
    installed: true,
    proxyUrl: anyProxy,
    reason: `global dispatcher set to EnvHttpProxyAgent (${anyProxy})`,
  };
}
