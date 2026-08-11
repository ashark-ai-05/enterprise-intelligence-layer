/**
 * Profile selection.
 *
 * `DATABASE_URL` absent → `embedded` at `EIL_DATA_DIR`. Present → `server`.
 * One environment variable is the whole switch.
 */

import { openEmbedded } from './embedded.js';
import type { Database, StorageProfile } from './port.js';

export interface OpenOptions {
  readonly databaseUrl?: string | undefined;
  readonly dataDir?: string | undefined;
}

export function profileFor(databaseUrl: string | undefined): StorageProfile {
  if (databaseUrl === undefined || databaseUrl.trim() === '') return 'embedded';
  if (databaseUrl.startsWith('pglite:')) return 'embedded';
  return 'server';
}

export function resolveOpenOptions(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenOptions {
  return {
    databaseUrl: env['DATABASE_URL'],
    dataDir: env['EIL_DATA_DIR'] ?? defaultDataDir(env),
  };
}

function defaultDataDir(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const home = env['HOME'] ?? env['USERPROFILE'];
  return home === undefined ? undefined : `${home}/.eil/data`;
}

export async function openDatabase(options: OpenOptions = resolveOpenOptions()): Promise<Database> {
  const profile = profileFor(options.databaseUrl);

  if (profile === 'embedded') {
    const url = options.databaseUrl;
    // `pglite:///path` — strip the scheme to get a filesystem path.
    const fromUrl = url?.startsWith('pglite:') ? url.replace(/^pglite:(\/\/)?/, '') : undefined;
    return openEmbedded(fromUrl !== undefined && fromUrl !== '' ? fromUrl : options.dataDir);
  }

  // The `server` profile is a small adapter over `pg` and is deliberately not
  // shipped untested: it needs a live PostgreSQL in CI to be worth trusting.
  // → tasks/TASKS.tsv P0-12
  throw new Error(
    'The server storage profile is not implemented yet (task P0-12). ' +
      'Unset DATABASE_URL to use the embedded profile.',
  );
}
