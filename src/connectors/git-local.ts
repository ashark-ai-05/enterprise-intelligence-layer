/**
 * Live Git ingestion from local repositories.
 *
 * This is real ingestion of real content, and it needs **no API, no
 * credentials and no proxy** — only the `git` binary and a checkout that
 * already exists on the machine. That matters: it is the one live source that
 * cannot be blocked by an unresolved corporate networking or auth question, so
 * it works on day one while everything else waits on those facts.
 *
 * Git is also the best-behaved source we have. The blob SHA *is* a content
 * hash, so change detection is exact rather than heuristic, and `git ls-tree`
 * enumerates a whole tree in one call.
 *
 * Selector: `{ repositories: ["/abs/path/to/repo"], refs: ["main"] }` — the
 * repositories are filesystem paths to existing clones.
 */

import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type { IngestionScope } from "../scopes/types.js";
import type {
  ConnectorBatch,
  ConnectorCursor,
  SourceConnector,
  SourceItem,
} from "./types.js";

const run = promisify(execFile);

/**
 * Paths never worth indexing.
 *
 * Typically 70–90% of the bytes in a checkout and near-zero search value.
 * Excluding them is ingestion policy, not an optimisation to add later.
 */
const EXCLUDED_PATH = new RegExp(
  [
    "(^|/)node_modules/",
    "(^|/)vendor/",
    "(^|/)dist/",
    "(^|/)build/",
    "(^|/)target/",
    "(^|/)\\.git/",
    "(^|/)__pycache__/",
    "\\.min\\.(js|css)$",
    "\\.(lock|sum)$",
    "(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|Cargo\\.lock|go\\.sum)$",
    "\\.(png|jpe?g|gif|ico|svg|pdf|zip|gz|tar|jar|class|so|dylib|dll|exe|bin|woff2?|ttf|eot|mp4|mov)$",
  ].join("|"),
  "i",
);

/** Larger than this is almost certainly generated, minified or data. */
const MAX_FILE_BYTES = 512 * 1024;

export interface LocalGitOptions {
  /** Files per batch. Keeps memory bounded on a large repository. */
  readonly batchSize?: number;
  /** Principal granted read access to ingested files. */
  readonly principal?: { domain: string; principalId: string };
  readonly maxFileBytes?: number;
}

interface TreeEntry {
  readonly blobSha: string;
  readonly size: number;
  readonly path: string;
}

async function git(
  repository: string,
  args: readonly string[],
): Promise<string> {
  // execFile with an argument array: no shell, so a path or ref containing
  // shell metacharacters is data rather than syntax.
  const { stdout } = await run("git", ["-C", repository, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export async function isGitRepository(repository: string): Promise<boolean> {
  try {
    const out = await git(repository, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Resolve the ref to index. Falls back through the scope's refs to HEAD. */
export async function resolveRef(
  repository: string,
  refs: readonly string[],
): Promise<string> {
  for (const ref of refs) {
    try {
      await git(repository, ["rev-parse", "--verify", `${ref}^{commit}`]);
      return ref;
    } catch {
      // Try the next candidate. A repository on `master`, or in detached HEAD,
      // is normal and must not be a hard failure.
    }
  }
  return "HEAD";
}

export async function listTree(
  repository: string,
  ref: string,
): Promise<TreeEntry[]> {
  // -l adds the blob size, so oversized files are skipped without reading them.
  const stdout = await git(repository, [
    "ls-tree",
    "-r",
    "-l",
    "--full-tree",
    ref,
  ]);
  const entries: TreeEntry[] = [];

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [meta, path] = line.split("\t");
    if (meta === undefined || path === undefined) continue;
    const parts = meta.split(/\s+/);
    const [, type, blobSha, size] = parts;
    if (type !== "blob" || blobSha === undefined) continue;
    entries.push({ blobSha, size: Number(size ?? 0), path });
  }

  return entries;
}

export function shouldIndex(
  path: string,
  size: number,
  maxBytes: number,
): boolean {
  if (EXCLUDED_PATH.test(path)) return false;
  if (!Number.isFinite(size) || size <= 0) return false;
  return size <= maxBytes;
}

/** NUL bytes mean binary. Cheaper and more reliable than trusting the extension. */
export function looksBinary(content: string): boolean {
  return content.includes("\u0000");
}

export class LocalGitConnector implements SourceConnector {
  readonly name = "git-local";
  readonly source = "git" as const;

  constructor(private readonly options: LocalGitOptions = {}) {}

  #repositories(scope: IngestionScope): string[] {
    const selector = scope.selector as { repositories?: unknown };
    const repositories = Array.isArray(selector.repositories)
      ? selector.repositories
      : [];
    return repositories
      .filter((value): value is string => typeof value === "string")
      .map((value) => resolve(value));
  }

  #refs(scope: IngestionScope): string[] {
    const selector = scope.selector as { refs?: unknown };
    const refs = Array.isArray(selector.refs) ? selector.refs : [];
    const named = refs.filter(
      (value): value is string => typeof value === "string",
    );
    return named.length > 0 ? named : ["main", "master"];
  }

  /** Combined head of every repository in the scope; changes when any of them moves. */
  async #headCommit(scope: IngestionScope): Promise<string> {
    const heads: string[] = [];
    for (const repository of this.#repositories(scope)) {
      if (!(await isGitRepository(repository))) continue;
      const ref = await resolveRef(repository, this.#refs(scope));
      heads.push((await git(repository, ["rev-parse", ref])).trim());
    }
    return heads.join(",");
  }

  async listCurrentIds(scope: IngestionScope): Promise<string[]> {
    const maxBytes = this.options.maxFileBytes ?? MAX_FILE_BYTES;
    const ids: string[] = [];

    for (const repository of this.#repositories(scope)) {
      if (!(await isGitRepository(repository))) continue;
      const ref = await resolveRef(repository, this.#refs(scope));
      const name = basename(repository);
      for (const entry of await listTree(repository, ref)) {
        if (!shouldIndex(entry.path, entry.size, maxBytes)) continue;
        ids.push(`${name}:${entry.path}`);
      }
    }

    return ids;
  }

  async read(
    scope: IngestionScope,
    cursor: ConnectorCursor | null,
  ): Promise<ConnectorBatch> {
    const batchSize = this.options.batchSize ?? 200;
    const maxBytes = this.options.maxFileBytes ?? MAX_FILE_BYTES;
    const principal = this.options.principal ?? {
      domain: "local",
      principalId: "owner",
    };
    // The cursor carries the commit it walked, not only a position.
    //
    // A positional offset alone is wrong for a repeatable sync: after the first
    // pass it sits past the end of the tree, so a file that changes afterwards
    // is never read again and the source silently stops updating. Recording the
    // commit means a new one restarts the walk, and an unchanged one is a no-op.
    const head = await this.#headCommit(scope);
    const offset = cursor?.commit === head ? (cursor?.sequence ?? 0) : 0;

    // Flatten every repository into one ordered list so the cursor is a stable
    // offset across the whole scope rather than per repository.
    const planned: {
      repository: string;
      ref: string;
      name: string;
      entry: TreeEntry;
    }[] = [];
    for (const repository of this.#repositories(scope)) {
      if (!(await isGitRepository(repository))) {
        throw new Error(`not a git repository: ${repository}`);
      }
      const ref = await resolveRef(repository, this.#refs(scope));
      const name = basename(repository);
      for (const entry of await listTree(repository, ref)) {
        if (shouldIndex(entry.path, entry.size, maxBytes)) {
          planned.push({ repository, ref, name, entry });
        }
      }
    }

    const slice = planned.slice(offset, offset + batchSize);
    const items: SourceItem[] = [];

    for (const { repository, ref, name, entry } of slice) {
      const content = await git(repository, [
        "cat-file",
        "blob",
        entry.blobSha,
      ]);
      if (looksBinary(content)) continue;

      const commit = (await git(repository, ["rev-parse", ref])).trim();
      const committed = (
        await git(repository, ["show", "-s", "--format=%cI", commit])
      ).trim();

      items.push({
        sourceObjectId: `${name}:${entry.path}`,
        // The blob SHA is a content hash, so an unchanged file is detected as
        // unchanged exactly rather than heuristically.
        sourceVersion: entry.blobSha,
        canonicalUri: `file://${repository}/${entry.path}`,
        title: `${name}/${entry.path}`,
        body: content,
        metadata: {
          repository: name,
          repositoryPath: repository,
          ref,
          commit,
          path: entry.path,
          blobSha: entry.blobSha,
          bytes: entry.size,
        },
        links: [],
        // Local mode: the person running this can already read the checkout, so
        // that is exactly the access being mirrored. A shared deployment must
        // derive repository permissions from the code host instead.
        acl: [{ ...principal, effect: "allow" }],
        sourceUpdatedAt: committed,
        deleted: false,
      });
    }

    const nextOffset = offset + slice.length;
    return {
      items,
      nextCursor: { sequence: nextOffset, commit: head },
      complete: nextOffset >= planned.length,
    };
  }
}
