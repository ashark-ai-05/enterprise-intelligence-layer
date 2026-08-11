/**
 * CQL and JQL text-search literals.
 *
 * Both Confluence's `text ~ "..."` and Jira's `text ~ "..."` pass their operand
 * to a Lucene-style text matcher. Two layers of escaping are therefore needed
 * and it is easy to do only the first:
 *
 *   1. **String-literal escaping** — backslash and double quote, so the literal
 *      terminates where we intend.
 *   2. **Lucene operator escaping** — `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`,
 *      because inside the literal these are still *operators*, not text.
 *
 * Skipping layer 2 means a query for `C++`, `retry?`, `foo:bar` or `a && b`
 * either errors or silently searches for something else. Users read that as
 * "search is broken for my query" and it is very hard to attribute.
 *
 * Adapted from `reference/sonnet-p0-federated-search`, which had layer 1.
 *
 * Not yet verified against a live Atlassian instance — see the note in the PR.
 * The escaping rules follow Lucene's documented reserved-character set.
 */

/** Lucene reserved characters, each escaped with a backslash. */
const LUCENE_RESERVED = /([+\-!(){}[\]^"~*?:\\/])/g;

/**
 * Lucene treats these as boolean operators when they appear as bare uppercase
 * words. Lower-casing neutralises them without changing what is matched, since
 * the text search itself is case-insensitive.
 */
const BOOLEAN_OPERATORS = /\b(AND|OR|NOT|TO)\b/g;

/** Escape a user query for use inside a CQL or JQL `text ~ "..."` literal. */
export function escapeTextSearch(value: string): string {
  return (
    value
      .replace(LUCENE_RESERVED, "\\$1")
      .replace(BOOLEAN_OPERATORS, (word) => word.toLowerCase())
      // `&&` and `||` survive the character class above because `&` and `|` are
      // only operators in pairs.
      .replace(/&&/g, "\\&\\&")
      .replace(/\|\|/g, "\\|\\|")
  );
}

/** Escape a value used as a bare CQL/JQL string literal, such as a space or project key. */
export function escapeIdentifier(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildConfluenceCql(
  query: string,
  spaceKeys: readonly string[] = [],
): string {
  const clauses = [`text ~ "${escapeTextSearch(query)}"`, "type = page"];
  if (spaceKeys.length > 0) {
    const keys = spaceKeys.map((key) => `"${escapeIdentifier(key)}"`).join(",");
    clauses.push(`space in (${keys})`);
  }
  return clauses.join(" and ");
}

export function buildJiraJql(
  query: string,
  projectKeys: readonly string[] = [],
): string {
  const clauses = [`text ~ "${escapeTextSearch(query)}"`];
  if (projectKeys.length > 0) {
    const keys = projectKeys
      .map((key) => `"${escapeIdentifier(key)}"`)
      .join(",");
    clauses.push(`project in (${keys})`);
  }
  // Newest first: for federated results the source's own recency ordering is a
  // better default than its relevance ordering, because RRF supplies relevance.
  return `${clauses.join(" and ")} order by updated desc`;
}
