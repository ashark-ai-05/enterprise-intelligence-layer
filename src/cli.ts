#!/usr/bin/env node
/**
 * eil — command line entry point.
 *
 * P0 surface only: `doctor`, `db migrate`, and `scope` management. Federated
 * search and MCP arrive with P0-6 and P0-8.
 */

import { runDoctor, type CheckResult, type DoctorReport } from './doctor/checks.js';
import { installGlobalProxy } from './net/proxy.js';
import { openDatabase, resolveOpenOptions } from './storage/open.js';
import { migrate } from './storage/migrate.js';
import { detectAndStoreCapabilities } from './storage/capabilities.js';
import {
  addScope,
  listScopes,
  removeScope,
  type ScopeSource,
  type SelectorKind,
  type ScopeTrigger,
} from './storage/scopes.js';

const USAGE = `eil — Enterprise Intelligence Layer

Usage:
  eil doctor [--json]              Run the constraint checklist and report evidence
  eil db migrate                   Apply pending migrations and probe capabilities
  eil scope add <source> <kind> <selector> [--schedule <interval>]
  eil scope list
  eil scope remove <id> [--purge]

Environment:
  DATABASE_URL          absent -> embedded (PGlite); postgres://... -> server
  EIL_DATA_DIR          embedded data directory (default ~/.eil/data)
  EIL_CONFLUENCE_URL    probed by doctor
  EIL_JIRA_URL          probed by doctor
  EIL_BITBUCKET_URL     probed by doctor
  EIL_MAAS_URL          probed by doctor, including whether it serves embeddings
  EIL_MAAS_TOKEN        bearer token for the MaaS probe
`;

const SYMBOL: Record<CheckResult['status'], string> = { pass: '✓', fail: '✗', skip: '–' };

function printReport(report: DoctorReport): void {
  const width = Math.max(...report.checks.map((c) => c.title.length));
  for (const check of report.checks) {
    process.stdout.write(`${SYMBOL[check.status]} ${check.title.padEnd(width)}  ${check.evidence}\n`);
    if (check.implication !== undefined) {
      process.stdout.write(`  ${' '.repeat(width)}  → ${check.implication}\n`);
    }
  }
  process.stdout.write(
    `\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped\n`,
  );
  if (report.skipped > 0) {
    process.stdout.write('A skip is an unknown, not a pass. Each one is a fact still worth establishing.\n');
  }
}

async function withDatabase<T>(work: (db: Awaited<ReturnType<typeof openDatabase>>) => Promise<T>): Promise<T> {
  const db = await openDatabase(resolveOpenOptions());
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === 'doctor') {
    // Install the dispatcher first: doctor's own probes must take the same
    // egress path the connectors will.
    const install = await installGlobalProxy();
    const report = await runDoctor();
    if (rest.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ proxy: install, ...report }, null, 2)}\n`);
    } else {
      process.stdout.write(`${install.reason}\n\n`);
      printReport(report);
    }
    return report.failed > 0 ? 1 : 0;
  }

  if (command === 'db' && rest[0] === 'migrate') {
    return withDatabase(async (db) => {
      const applied = await migrate(db);
      const capabilities = await detectAndStoreCapabilities(db);
      process.stdout.write(
        applied.length === 0
          ? 'No pending migrations.\n'
          : `Applied ${applied.map((m) => m.name).join(', ')}\n`,
      );
      process.stdout.write(`Profile: ${db.profile}\n`);
      for (const [name, available] of Object.entries(capabilities)) {
        process.stdout.write(`  ${available ? '✓' : '–'} ${name}\n`);
      }
      return 0;
    });
  }

  if (command === 'scope') {
    const [action, ...args] = rest;

    if (action === 'list') {
      return withDatabase(async (db) => {
        const scopes = await listScopes(db);
        if (scopes.length === 0) {
          process.stdout.write('No scopes. Nothing has been ingested.\n');
          return 0;
        }
        for (const scope of scopes) {
          const when = scope.lastSyncAt === null ? 'never synced' : scope.lastSyncAt.toISOString();
          process.stdout.write(
            `${scope.enabled ? ' ' : '!'} ${scope.id}  [${scope.trigger}${scope.schedule === null ? '' : ` ${scope.schedule}`}]  ${when}\n`,
          );
        }
        return 0;
      });
    }

    if (action === 'add') {
      const [source, kind, selector] = args;
      if (source === undefined || kind === undefined || selector === undefined) {
        process.stderr.write('usage: eil scope add <source> <kind> <selector> [--schedule <interval>]\n');
        return 2;
      }
      const scheduleIndex = args.indexOf('--schedule');
      const schedule = scheduleIndex === -1 ? undefined : args[scheduleIndex + 1];
      const trigger: ScopeTrigger = schedule === undefined ? 'manual' : 'scheduled';

      return withDatabase(async (db) => {
        await migrate(db);
        const scope = await addScope(db, {
          source: source as ScopeSource,
          selectorKind: kind as SelectorKind,
          selector,
          trigger,
          ...(schedule === undefined ? {} : { schedule }),
          addedBy: process.env['USER'] ?? 'unknown',
        });
        process.stdout.write(`Added ${scope.id}\n`);
        return 0;
      });
    }

    if (action === 'remove') {
      const id = args[0];
      if (id === undefined) {
        process.stderr.write('usage: eil scope remove <id> [--purge]\n');
        return 2;
      }
      const disposition = args.includes('--purge') ? 'purge' : 'retain';
      return withDatabase(async (db) => {
        const result = await removeScope(db, id, disposition);
        if (!result.scopeRemoved) {
          process.stderr.write(`No such scope: ${id}\n`);
          return 1;
        }
        process.stdout.write(
          disposition === 'purge'
            ? `Removed ${id}: purged ${result.documentsPurged}, retained ${result.documentsRetained} claimed by other scopes\n`
            : `Removed ${id}. Documents retained — pass --purge to delete those no other scope claims.\n`,
        );
        return 0;
      });
    }
  }

  process.stderr.write(`Unknown command: ${argv.join(' ')}\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
