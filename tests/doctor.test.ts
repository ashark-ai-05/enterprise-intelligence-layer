import { describe, expect, it } from "vitest";
import {
  type DoctorEnvironment,
  checkHostReachable,
  checkMaasEmbeddings,
  checkNodeVersion,
  checkProxyConfiguration,
  summarise,
  targetsFromEnv,
} from "../src/doctor/checks.js";
import { readProxyConfig } from "../src/net/proxy.js";

const environmentWith = (
  overrides: Partial<DoctorEnvironment> & {
    env?: Record<string, string | undefined>;
  },
): DoctorEnvironment => ({
  env: overrides.env ?? {},
  nodeVersion: overrides.nodeVersion ?? "v22.0.0",
  fetchImpl:
    overrides.fetchImpl ??
    (() => Promise.reject(new Error("no network in tests"))),
  now: overrides.now ?? (() => 0),
});

/** A clock that advances a fixed amount per call, so durations are deterministic. */
const clock = (stepMs: number) => {
  let t = 0;
  return () => {
    const current = t;
    t += stepMs;
    return current;
  };
};

describe("checkNodeVersion", () => {
  it("passes on 20 and above", () => {
    expect(
      checkNodeVersion(environmentWith({ nodeVersion: "v20.11.0" })).status,
    ).toBe("pass");
    expect(
      checkNodeVersion(environmentWith({ nodeVersion: "v24.18.0" })).status,
    ).toBe("pass");
  });

  it("fails below 20 and says why it matters", () => {
    const result = checkNodeVersion(
      environmentWith({ nodeVersion: "v18.19.0" }),
    );
    expect(result.status).toBe("fail");
    expect(result.implication).toMatch(/Node 20/);
  });

  it("reports the observed version as evidence, not a verdict", () => {
    expect(
      checkNodeVersion(environmentWith({ nodeVersion: "v22.1.0" })).evidence,
    ).toContain("v22.1.0");
  });
});

describe("checkProxyConfiguration", () => {
  it("skips rather than fails when no proxy is set, and says what to confirm", () => {
    const [configured] = checkProxyConfiguration(environmentWith({ env: {} }));
    expect(configured!.status).toBe("skip");
    expect(configured!.implication).toMatch(/direct egress/);
  });

  it("reports the configured proxies", () => {
    const [configured] = checkProxyConfiguration(
      environmentWith({ env: { HTTPS_PROXY: "http://proxy:3129" } }),
    );
    expect(configured!.status).toBe("pass");
    expect(configured!.evidence).toContain("http://proxy:3129");
  });

  it("renders the parsed NO_PROXY rules back, so a mis-parse is visible", () => {
    const checks = checkProxyConfiguration(
      environmentWith({
        env: { NO_PROXY: ".corp.example,build.internal:8080" },
      }),
    );
    const bypass = checks.find((c) => c.id === "proxy.no_proxy");
    expect(bypass!.evidence).toBe(".corp.example, build.internal:8080");
  });

  it("warns when NO_PROXY is unset that everything is proxied", () => {
    const checks = checkProxyConfiguration(environmentWith({ env: {} }));
    expect(checks.find((c) => c.id === "proxy.no_proxy")!.evidence).toMatch(
      /every host goes through/,
    );
  });

  it("flags a missing corporate CA bundle", () => {
    const checks = checkProxyConfiguration(environmentWith({ env: {} }));
    const tls = checks.find((c) => c.id === "proxy.tls");
    expect(tls!.status).toBe("skip");
    expect(tls!.implication).toMatch(/self-signed/);
  });
});

describe("targetsFromEnv", () => {
  it("probes only what is configured", () => {
    expect(targetsFromEnv({})).toEqual([]);
  });

  it("picks up each configured source", () => {
    const targets = targetsFromEnv({
      EIL_CONFLUENCE_URL: "https://wiki.corp.example",
      EIL_JIRA_URL: "https://jira.corp.example",
    });
    expect(targets.map((t) => t.id)).toEqual([
      "source.confluence",
      "source.jira",
    ]);
  });

  it("ignores blank values rather than probing an empty URL", () => {
    expect(targetsFromEnv({ EIL_CONFLUENCE_URL: "   " })).toEqual([]);
  });
});

describe("checkHostReachable", () => {
  const target = {
    id: "source.confluence",
    label: "Confluence",
    url: "https://wiki.corp.example/rest/api",
  };

  it("passes on any HTTP response — reaching the server is the fact being established", async () => {
    const environment = environmentWith({
      fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
      now: clock(120),
    });
    const result = await checkHostReachable(
      environment,
      target,
      readProxyConfig({}),
    );
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("HTTP 200");
  });

  it("treats 401 as connectivity proven, not a network failure", async () => {
    const environment = environmentWith({
      fetchImpl: () => Promise.resolve(new Response(null, { status: 401 })),
      now: clock(50),
    });
    const result = await checkHostReachable(
      environment,
      target,
      readProxyConfig({}),
    );
    expect(result.status).toBe("pass");
    expect(result.implication).toMatch(/credentials, not the network/);
  });

  it("records which route was taken, so a proxy misconfiguration is legible", async () => {
    const config = readProxyConfig({ HTTPS_PROXY: "http://proxy:3129" });
    const environment = environmentWith({
      fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
      now: clock(10),
    });
    const result = await checkHostReachable(environment, target, config);
    expect(result.evidence).toContain("via http://proxy:3129");
  });

  it("reports a bypassed host as direct", async () => {
    const config = readProxyConfig({
      HTTPS_PROXY: "http://proxy:3129",
      NO_PROXY: ".corp.example",
    });
    const environment = environmentWith({
      fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
      now: clock(10),
    });
    const result = await checkHostReachable(environment, target, config);
    expect(result.evidence).toContain("(direct)");
  });

  it("names the missing-dispatcher symptom when the request times out", async () => {
    // The bug this design keeps warning about: a hang reads as "the source is slow".
    const environment = environmentWith({
      fetchImpl: () => Promise.reject(new Error("The operation was aborted")),
      now: clock(10_000),
    });
    const result = await checkHostReachable(
      environment,
      target,
      readProxyConfig({}),
    );
    expect(result.status).toBe("fail");
    expect(result.implication).toMatch(/missing-proxy-dispatcher/);
  });

  it("gives ordinary connection failures an ordinary explanation", async () => {
    const environment = environmentWith({
      fetchImpl: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
      now: clock(5),
    });
    const result = await checkHostReachable(
      environment,
      target,
      readProxyConfig({}),
    );
    expect(result.status).toBe("fail");
    expect(result.implication).toMatch(/DNS/);
  });
});

describe("checkMaasEmbeddings", () => {
  it("skips when the endpoint is unknown and states the standing default", async () => {
    const result = await checkMaasEmbeddings(environmentWith({ env: {} }));
    expect(result.status).toBe("skip");
    expect(result.implication).toMatch(/bulk embedding stays local/);
  });

  it("passes on HTTP 200 but still says bulk stays local", async () => {
    const result = await checkMaasEmbeddings(
      environmentWith({
        env: { EIL_MAAS_URL: "https://maas.corp.example/v1" },
        fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
        now: clock(40),
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.implication).toMatch(/stays local/);
  });

  it("fails on 404 and names the consequence for semantic search", async () => {
    const result = await checkMaasEmbeddings(
      environmentWith({
        env: { EIL_MAAS_URL: "https://maas.corp.example/v1" },
        fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })),
        now: clock(40),
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.implication).toMatch(/local ONNX path/);
  });

  it("does not send an Authorization header when no token is configured", async () => {
    let sentAuth: string | null = null;
    await checkMaasEmbeddings(
      environmentWith({
        env: { EIL_MAAS_URL: "https://maas.corp.example/v1" },
        fetchImpl: (_url, init) => {
          sentAuth = new Headers(init?.headers).get("authorization");
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
        now: clock(1),
      }),
    );
    expect(sentAuth).toBeNull();
  });
});

describe("summarise", () => {
  it("counts each status", () => {
    const report = summarise([
      { id: "a", title: "a", status: "pass", evidence: "" },
      { id: "b", title: "b", status: "fail", evidence: "" },
      { id: "c", title: "c", status: "skip", evidence: "" },
      { id: "d", title: "d", status: "pass", evidence: "" },
    ]);
    expect(report).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
  });
});
