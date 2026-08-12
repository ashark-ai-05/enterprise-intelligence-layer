#!/usr/bin/env node
/**
 * eil — command line entry point.
 *
 * Currently `doctor` only. Scope and database commands belong to the scope
 * service in `src/scopes`; they get a CLI surface when that service does, so
 * there is one implementation rather than two.
 */

import {
  CREDENTIAL_SOURCES,
  credentialsEnvironment,
  isCredentialSource,
  openCredentialStore,
} from "./credentials/keychain.js";
import {
  type CheckResult,
  type DoctorReport,
  runDoctor,
} from "./doctor/checks.js";
import { installGlobalProxy } from "./net/proxy.js";
import { parseSearchFlags } from "./retrieval/query-filters.js";
import type { Source } from "./scopes/types.js";
import {
  FixtureConnectorRegistry,
  LiveConnectorRegistry,
  addScopeCommand,
  embedCommand,
  ingestCommand,
  listScopesCommand,
  removeScopeCommand,
  resolveTenant,
  searchCommand,
} from "./serving/cli-commands.js";
import { serveMcp } from "./serving/serve.js";
import { openDatabase } from "./storage/database.js";
import { migrate } from "./storage/migrations.js";

const USAGE = `eil — Enterprise Intelligence Layer

Usage:
  eil doctor [--json]                 Check this machine and report evidence
  eil credentials set <source> --url <url> --principal <id> [--email <email>]
  eil credentials list                List configured sources (never secrets)
  eil credentials remove <source>     Remove a source profile from OS keychain
  eil scope add <source> <kind> <value...> [--schedule 1h]
  eil scope list
  eil scope remove <id> [--purge]
  eil ingest [--scope <id>] [--fixture]   Sync scopes through the durable queue
  eil embed                               Embed new chunks for semantic search
  eil search "<query>" [--source git,jira] [--path src/] [--limit 10] [--json]
      Quote the query to require the words adjacent, in order.
  eil serve                           Serve the MCP tool surface over stdio

Environment:
  EIL_CONFLUENCE_URL      probed for reachability, and live connector base URL
  EIL_CONFLUENCE_TOKEN    API token (Bearer, or Basic with EIL_CONFLUENCE_EMAIL)
  EIL_CONFLUENCE_EMAIL    Cloud account email for Basic authentication
  EIL_CONFLUENCE_PRINCIPAL current source account id/email for personal ACLs
  EIL_JIRA_URL            probed for reachability, and live connector base URL
  EIL_JIRA_TOKEN          API token (Bearer, or Basic with EIL_JIRA_EMAIL)
  EIL_JIRA_EMAIL          Cloud account email for Basic authentication
  EIL_JIRA_PRINCIPAL      current source account id/email for personal ACLs
  EIL_BITBUCKET_URL       probed for reachability
  EIL_NPM_REGISTRY        probed for reachability
  EIL_MAAS_URL            probed, including whether it serves embeddings
  EIL_MAAS_TOKEN          bearer token for the MaaS probe
  EIL_MAAS_MODEL          model name sent with the embeddings probe

  HTTPS_PROXY / HTTP_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS  inspected and reported
`;

const SYMBOL: Record<CheckResult["status"], string> = {
  pass: "✓",
  fail: "✗",
  skip: "–",
};

function printReport(report: DoctorReport): void {
  const width = Math.max(...report.checks.map((check) => check.title.length));

  for (const check of report.checks) {
    process.stdout.write(
      `${SYMBOL[check.status]} ${check.title.padEnd(width)}  ${check.evidence}\n`,
    );
    if (check.implication !== undefined) {
      process.stdout.write(`  ${" ".repeat(width)}  → ${check.implication}\n`);
    }
  }

  process.stdout.write(
    `\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped\n`,
  );
  if (report.skipped > 0) {
    process.stdout.write(
      "A skip is an unknown, not a pass. Each one is a fact still worth establishing.\n",
    );
  }
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write("PAT/token (stored in OS keychain): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      process.stdin.off("data", onData);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write("\n");
          process.stdin.off("data", onData);
          reject(new Error("Credential entry cancelled"));
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

async function runCredentialsCommand(rest: readonly string[]): Promise<number> {
  const [action, sourceValue] = rest;
  const store = openCredentialStore();
  if (action === "list") {
    for (const source of CREDENTIAL_SOURCES) {
      const profile = await store.get(source);
      process.stdout.write(
        `${source.padEnd(12)} ${profile ? `configured  ${profile.url}  principal=${profile.principal}` : "not configured"}\n`,
      );
    }
    return 0;
  }
  if (!sourceValue || !isCredentialSource(sourceValue)) {
    process.stderr.write(
      "usage: eil credentials <set|remove> <confluence|jira|bitbucket>\n",
    );
    return 2;
  }
  if (action === "remove") {
    const removed = await store.remove(sourceValue);
    process.stdout.write(
      `${removed ? "Removed" : "No stored credentials for"} ${sourceValue}\n`,
    );
    return 0;
  }
  if (action === "set") {
    const url = flag(rest, "--url");
    const principal = flag(rest, "--principal");
    const email = flag(rest, "--email");
    if (!url || !principal) {
      process.stderr.write(
        "usage: eil credentials set <source> --url <url> --principal <id> [--email <email>]\n",
      );
      return 2;
    }
    const token = await readSecret();
    if (!token) throw new Error("PAT/token cannot be empty");
    await store.set({
      source: sourceValue,
      url,
      principal,
      token,
      ...(email ? { email } : {}),
    });
    process.stdout.write(`Stored ${sourceValue} credentials in OS keychain.\n`);
    return 0;
  }
  process.stderr.write("usage: eil credentials <set|list|remove>\n");
  return 2;
}

async function runDataCommand(
  command: string,
  rest: readonly string[],
  db: Awaited<ReturnType<typeof openDatabase>>,
  tenant: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  if (command === "scope") {
    const [action, ...args] = rest;

    if (action === "list") {
      const scopes = await listScopesCommand(db, tenant);
      if (scopes.length === 0) {
        process.stdout.write(
          "No scopes. Nothing has been selected for indexing.\n",
        );
        return 0;
      }
      for (const scope of scopes) {
        process.stdout.write(
          `${scope.id}  ${scope.source}:${scope.selectorKind}  ${JSON.stringify(scope.selector)}  [${scope.refreshMode}]\n`,
        );
      }
      return 0;
    }

    if (action === "add") {
      // Drop flags *and* their values; otherwise `--schedule 1h` silently
      // becomes a selector value and creates a scope for a key named "1h".
      const positional: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        const value = args[index] as string;
        if (value.startsWith("--")) {
          index += 1;
          continue;
        }
        positional.push(value);
      }
      const [source, kind, ...values] = positional;
      if (source === undefined || kind === undefined) {
        process.stderr.write(
          "usage: eil scope add <source> <kind> <value...> [--schedule 1h]\n",
        );
        return 2;
      }
      const schedule = flag(args, "--schedule");
      const scope = await addScopeCommand(db, tenant, {
        source: source as Source,
        kind,
        values,
        ...(schedule === undefined ? {} : { schedule }),
        addedBy: process.env.USER ?? "cli",
      });
      process.stdout.write(`Added ${scope.id}\n`);
      return 0;
    }

    if (action === "remove") {
      const id = args[0];
      if (id === undefined) {
        process.stderr.write("usage: eil scope remove <id> [--purge]\n");
        return 2;
      }
      await removeScopeCommand(db, tenant, id, args.includes("--purge"));
      process.stdout.write(`Removed ${id}\n`);
      return 0;
    }

    process.stderr.write("usage: eil scope <add|list|remove>\n");
    return 2;
  }

  if (command === "ingest") {
    const all = await listScopesCommand(db, tenant);
    const only = flag(rest, "--scope");
    const scopes =
      only === undefined ? all : all.filter((scope) => scope.id === only);

    if (scopes.length === 0) {
      process.stderr.write(
        "No matching scopes. Add one with: eil scope add <source> <kind> <value>\n",
      );
      return 1;
    }

    const registry = rest.includes("--fixture")
      ? new FixtureConnectorRegistry()
      : new LiveConnectorRegistry(environment);

    const outcomes = await ingestCommand(db, tenant, scopes, registry);
    let failed = 0;
    for (const outcome of outcomes) {
      if (outcome.status === "completed") {
        process.stdout.write(
          `${outcome.scopeId}: ${JSON.stringify(outcome.ingestion ?? {})}\n`,
        );
      } else {
        failed += 1;
        process.stderr.write(
          `${outcome.scopeId}: ${outcome.status}\n${outcome.error ?? ""}\n`,
        );
      }
    }
    return failed > 0 ? 1 : 0;
  }

  if (command === "embed") {
    const result = await embedCommand(db);
    process.stdout.write(
      `Embedded ${result.embedded} chunks with ${result.modelId}\n`,
    );
    return 0;
  }

  if (command === "search") {
    const query = rest.find((value) => !value.startsWith("--"));
    if (query === undefined) {
      process.stderr.write(
        'usage: eil search "<query>" [--source git,jira] [--path src/] [--limit 10] [--json]\n',
      );
      return 2;
    }

    const { limit, json, ...filters } = parseSearchFlags(rest);
    const result = await searchCommand(db, tenant, query, limit, filters);

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ query, ...result }, null, 2)}\n`,
      );
      return 0;
    }

    if (result.hits.length === 0) {
      process.stdout.write("No results.\n");
      // Say what would widen the search, rather than leaving a dead end.
      const semanticSkipped = result.armsSkipped.some(
        (arm) => arm.arm === "semantic",
      );
      if (semanticSkipped) {
        process.stdout.write(
          "Semantic search is off because nothing is embedded yet — run: eil embed\n",
        );
      }
      if (filters.sources !== undefined || filters.path !== undefined) {
        process.stdout.write(
          "Filters are active; try again without --source/--path.\n",
        );
      }
      return 0;
    }

    for (const hit of result.hits) {
      const arms = hit.arms.map((arm) => arm.arm).join(", ");
      process.stdout.write(`${hit.source.padEnd(11)} ${hit.title}\n`);
      process.stdout.write(`  ${hit.url}\n`);
      if (hit.snippet !== undefined && hit.snippet !== "") {
        process.stdout.write(
          `  ${hit.snippet.replace(/\s+/g, " ").slice(0, 160).trim()}\n`,
        );
      }
      // Why it matched: which arms contributed, and whether it is live.
      process.stdout.write(
        `  matched by: ${arms}${hit.syncedAt === null ? " (live)" : ""}\n\n`,
      );
    }
    return 0;
  }

  return 2;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "doctor") {
    // Install the dispatcher first: doctor's own probes must take the same
    // egress path the connectors will, or it is measuring something else.
    const install = await installGlobalProxy();
    const report = await runDoctor();

    if (rest.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify({ proxy: install, ...report }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${install.reason}\n\n`);
      printReport(report);
    }

    return report.failed > 0 ? 1 : 0;
  }

  if (command === "credentials") {
    return await runCredentialsCommand(rest);
  }

  if (command === "serve") {
    await serveMcp();
    return 0;
  }

  if (
    command === "scope" ||
    command === "ingest" ||
    command === "search" ||
    command === "embed"
  ) {
    await installGlobalProxy();
    const tenant = resolveTenant();
    const db = await openDatabase({});
    await migrate(db);
    try {
      let environment = process.env;
      if (process.platform === "darwin") {
        environment = await credentialsEnvironment(openCredentialStore());
      }
      return await runDataCommand(command, rest, db, tenant, environment);
    } finally {
      await db.close();
    }
  }

  process.stderr.write(`Unknown command: ${argv.join(" ")}\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
