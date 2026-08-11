import { describe, expect, it } from "vitest";
import {
  isBypassed,
  parseNoProxy,
  readProxyConfig,
  shouldProxy,
} from "../src/net/proxy.js";

const config = (env: Record<string, string | undefined>) =>
  readProxyConfig(env);

describe("parseNoProxy", () => {
  it("returns nothing for an unset value", () => {
    expect(parseNoProxy(undefined)).toEqual({ rules: [], bypassAll: false });
  });

  it("splits on commas and whitespace", () => {
    const { rules } = parseNoProxy("a.example, b.example\tc.example");
    expect(rules.map((r) => r.host)).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
  });

  it("treats a lone * as bypass-everything", () => {
    expect(parseNoProxy("*").bypassAll).toBe(true);
    expect(parseNoProxy("corp.example,*").bypassAll).toBe(true);
  });

  it("reads a leading dot as subdomains-only", () => {
    const { rules } = parseNoProxy(".corp.example");
    expect(rules[0]).toEqual({ host: "corp.example", subdomainsOnly: true });
  });

  it("reads *.host as the same thing as .host", () => {
    expect(parseNoProxy("*.corp.example").rules[0]).toEqual({
      host: "corp.example",
      subdomainsOnly: true,
    });
  });

  it("parses host:port", () => {
    expect(parseNoProxy("wiki.corp.example:8443").rules[0]).toEqual({
      host: "wiki.corp.example",
      port: 8443,
      subdomainsOnly: false,
    });
  });

  it("does not mistake a non-numeric suffix for a port", () => {
    expect(parseNoProxy("wiki.corp.example:notaport").rules[0]).toEqual({
      host: "wiki.corp.example:notaport",
      subdomainsOnly: false,
    });
  });

  it("lower-cases hosts so matching is case-insensitive", () => {
    expect(parseNoProxy("WIKI.Corp.Example").rules[0]!.host).toBe(
      "wiki.corp.example",
    );
  });

  it("ignores empty entries from trailing or doubled separators", () => {
    expect(parseNoProxy("a.example,,b.example,").rules).toHaveLength(2);
  });
});

describe("readProxyConfig", () => {
  it("prefers lower-case env vars over upper-case", () => {
    const c = config({
      https_proxy: "http://lower:3128",
      HTTPS_PROXY: "http://upper:3128",
    });
    expect(c.httpsProxy).toBe("http://lower:3128");
  });

  it("accepts upper-case when lower-case is absent", () => {
    expect(config({ HTTPS_PROXY: "http://upper:3128" }).httpsProxy).toBe(
      "http://upper:3128",
    );
  });

  it("reports no proxy when the environment is clean", () => {
    const c = config({});
    expect(c.httpProxy).toBeUndefined();
    expect(c.httpsProxy).toBeUndefined();
    expect(c.bypassAll).toBe(false);
  });

  it("treats an empty value as unset, not as a proxy at the empty URL", () => {
    // `HTTPS_PROXY=` is a common way to disable an inherited proxy. Treating it
    // as configured routes every request to nowhere.
    const c = config({ HTTPS_PROXY: "", HTTP_PROXY: "   " });
    expect(c.httpsProxy).toBeUndefined();
    expect(c.httpProxy).toBeUndefined();
    expect(shouldProxy("https://example.com/", c)).toBeUndefined();
  });

  it("falls back to the upper-case variable when the lower-case one is empty", () => {
    const c = config({ https_proxy: "", HTTPS_PROXY: "http://proxy:3129" });
    expect(c.httpsProxy).toBe("http://proxy:3129");
  });
});

describe("isBypassed", () => {
  const c = config({ NO_PROXY: "localhost,.corp.example,build.internal:8080" });

  it("matches an exact host", () => {
    expect(isBypassed(new URL("http://localhost/x"), c)).toBe(true);
  });

  it("matches subdomains of a dotted rule", () => {
    expect(isBypassed(new URL("https://wiki.corp.example/x"), c)).toBe(true);
    expect(isBypassed(new URL("https://deep.wiki.corp.example/x"), c)).toBe(
      true,
    );
  });

  it("does not match the bare domain of a dotted rule", () => {
    expect(isBypassed(new URL("https://corp.example/x"), c)).toBe(false);
  });

  it("matches subdomains of a bare rule too", () => {
    // A bare `localhost` rule should not match `x.localhost`... but a bare
    // domain rule conventionally does cover its subdomains. Assert the
    // behaviour explicitly so a future change is a deliberate one.
    expect(isBypassed(new URL("http://sub.localhost/x"), c)).toBe(true);
  });

  it("honours a port constraint", () => {
    expect(isBypassed(new URL("http://build.internal:8080/x"), c)).toBe(true);
    expect(isBypassed(new URL("http://build.internal:9090/x"), c)).toBe(false);
  });

  it("uses the protocol default port when the URL omits one", () => {
    const withDefault = config({ NO_PROXY: "secure.internal:443" });
    expect(isBypassed(new URL("https://secure.internal/x"), withDefault)).toBe(
      true,
    );
    expect(isBypassed(new URL("http://secure.internal/x"), withDefault)).toBe(
      false,
    );
  });

  it("is case-insensitive on the URL host", () => {
    expect(isBypassed(new URL("https://WIKI.CORP.EXAMPLE/x"), c)).toBe(true);
  });

  it("bypasses everything when NO_PROXY is *", () => {
    const all = config({ NO_PROXY: "*", HTTPS_PROXY: "http://proxy:3128" });
    expect(isBypassed(new URL("https://anything.example/x"), all)).toBe(true);
  });

  it("does not treat a suffix collision as a match", () => {
    // `notcorp.example` must not match a `.corp.example` rule.
    expect(isBypassed(new URL("https://notcorp.example/x"), c)).toBe(false);
  });
});

describe("shouldProxy", () => {
  const c = config({
    HTTP_PROXY: "http://proxy:3128",
    HTTPS_PROXY: "http://proxy:3129",
    NO_PROXY: ".corp.example",
  });

  it("routes external https through the https proxy", () => {
    expect(shouldProxy("https://api.atlassian.net/rest", c)).toBe(
      "http://proxy:3129",
    );
  });

  it("routes external http through the http proxy", () => {
    expect(shouldProxy("http://example.com/", c)).toBe("http://proxy:3128");
  });

  it("goes direct for a NO_PROXY host — the case that silently hangs when this is wrong", () => {
    expect(
      shouldProxy("https://wiki.corp.example/rest/api", c),
    ).toBeUndefined();
  });

  it("goes direct when no proxy is configured at all", () => {
    expect(shouldProxy("https://example.com/", config({}))).toBeUndefined();
  });

  it("ignores non-http protocols", () => {
    expect(shouldProxy("ftp://files.example.com/x", c)).toBeUndefined();
  });

  it("accepts a URL object as well as a string", () => {
    expect(shouldProxy(new URL("https://example.com/"), c)).toBe(
      "http://proxy:3129",
    );
  });
});
