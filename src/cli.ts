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

const USAGE = `eil — Enterprise Intelligence Layer

Usage:
  eil doctor [--json]     Run the constraint checklist and report evidence

Environment:
  EIL_CONFLUENCE_URL      probed for reachability
  EIL_JIRA_URL            probed for reachability
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
