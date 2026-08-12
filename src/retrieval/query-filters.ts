/**
 * Narrowing a search across many sources.
 *
 * Once code, tickets and wiki pages are in one index, the useful question is
 * often not "find this everywhere" but "find this *here*" — in one repository,
 * under one path, in tickets only. Without that, more sources means more noise.
 *
 * Also home to phrase detection. The query classifier has always recognised a
 * quoted phrase and boosted the exact arm for it, but **no arm enforced
 * adjacency** — `"payment retry policy"` matched documents containing those
 * three words anywhere, in any order. The quoting looked respected and was not.
 */

/** A quoted query means the words must appear together, in order. */
export function parsePhrase(text: string): {
  phrase: string | null;
  text: string;
} {
  const trimmed = text.trim();
  const quoted = /^"(.+)"$/s.exec(trimmed);
  if (quoted?.[1] !== undefined) return { phrase: quoted[1], text: quoted[1] };
  return { phrase: null, text: trimmed };
}

export interface SearchFilters {
  /** Restrict to these sources: `git`, `jira`, `confluence`, `files`. */
  readonly sources?: readonly string[];
  /**
   * Substring of the document id, matched case-insensitively.
   *
   * Ids are `<repo>:<path>` for code and the issue key or page id elsewhere, so
   * one filter serves "this repository", "this directory" and "this ticket
   * prefix" without inventing a per-source vocabulary that would then have to
   * be kept in step with every connector.
   */
  readonly path?: string;
}

export function matchesFilters(
  hit: { readonly id: string; readonly source: string },
  filters: SearchFilters,
): boolean {
  if (filters.sources !== undefined && filters.sources.length > 0) {
    if (!filters.sources.includes(hit.source)) return false;
  }
  if (filters.path !== undefined && filters.path !== "") {
    if (!hit.id.toLowerCase().includes(filters.path.toLowerCase()))
      return false;
  }
  return true;
}

/** Parse `--source`, `--path` and `--limit` from argv-style flags. */
export function parseSearchFlags(
  args: readonly string[],
): SearchFilters & { limit: number; json: boolean } {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };

  const sources = value("--source");
  const path = value("--path");
  const limit = Number(value("--limit") ?? 10);

  return {
    ...(sources === undefined
      ? {}
      : { sources: sources.split(",").filter(Boolean) }),
    ...(path === undefined ? {} : { path }),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10,
    json: args.includes("--json"),
  };
}
