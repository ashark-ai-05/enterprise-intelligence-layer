#!/usr/bin/env node
/**
 * eil — command line entry point.
 *
 * Currently `doctor` only. Scope and database commands belong to the scope
 * service in `src/scopes`; they get a CLI surface when that service does, so
 * there is one implementation rather than two.
 */

import {
  type CheckResult,
  type DoctorReport,
  runDoctor,
} from "./doctor/checks.js";
import { installGlobalProxy } from "./net/proxy.js";
import type { Source } from "./scopes/types.js";
import {
  FixtureConnectorRegistry,
  LiveConnectorRegistry,
  addScopeCommand,
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
  eil scope add <source> <kind> <value...> [--schedule 1h]
  eil scope list
  eil scope remove <id> [--purge]
  eil ingest [--scope <id>] [--fixture]   Sync scopes through the durable queue
  eil search "<query>" [--limit 10]       Search what has been ingested
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

async function runDataCommand(
  command: string,
  rest: readonly string[],
  db: Awaited<ReturnType<typeof openDatabase>>,
  tenant: string,
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
      : new LiveConnectorRegistry();

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

  if (command === "search") {
    const query = rest.find((value) => !value.startsWith("--"));
    if (query === undefined) {
      process.stderr.write('usage: eil search "<query>" [--limit 10]\n');
      return 2;
    }
    const limit = Number(flag(rest, "--limit") ?? 10);
    const result = await searchCommand(db, tenant, query, limit);

    if (result.hits.length === 0) {
      process.stdout.write("No results.\n");
      return 0;
    }
    for (const hit of result.hits) {
      process.stdout.write(
        `${hit.source.padEnd(11)} ${hit.id}\n  ${hit.title}\n  ${hit.url}\n`,
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

  if (command === "serve") {
    await serveMcp();
    return 0;
  }

  if (command === "scope" || command === "ingest" || command === "search") {
    await installGlobalProxy();
    const tenant = resolveTenant();
    const db = await openDatabase({});
    await migrate(db);
    try {
      return await runDataCommand(command, rest, db, tenant);
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
