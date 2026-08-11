import type { ValidatedSourceItem } from "../connectors/types.js";
import type { Source } from "../scopes/types.js";
import type { NormalizedChunk, SourceNormalizer } from "./types.js";

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function fallback(item: ValidatedSourceItem): NormalizedChunk[] {
  if (!item.body.trim()) return [];
  return [
    {
      stableKey: "body",
      kind: "section",
      text: item.body.trim(),
      location: {},
    },
  ];
}

function confluence(item: ValidatedSourceItem): NormalizedChunk[] {
  const sections = records(item.metadata.sections);
  if (sections.length === 0) return fallback(item);
  return sections.flatMap((section, ordinal) => {
    const body = text(section.text);
    if (!body) return [];
    const headingPath = Array.isArray(section.headingPath)
      ? section.headingPath.filter(
          (heading): heading is string => typeof heading === "string",
        )
      : [];
    const anchor = text(section.anchor) ?? `section-${ordinal}`;
    return [
      {
        stableKey: `section:${anchor}`,
        kind: "section" as const,
        text: body,
        location: { anchor, headingPath },
      },
    ];
  });
}

function jira(item: ValidatedSourceItem): NormalizedChunk[] {
  const chunks: NormalizedChunk[] = [];
  const description = text(item.metadata.description) ?? item.body.trim();
  if (description) {
    chunks.push({
      stableKey: "description",
      kind: "section",
      text: description,
      location: { field: "description" },
    });
  }
  for (const [ordinal, comment] of records(item.metadata.comments).entries()) {
    const body = text(comment.body);
    if (!body) continue;
    const id = text(comment.id) ?? `ordinal-${ordinal}`;
    const visibility = comment.visibility;
    const aclOverride =
      visibility && typeof visibility === "object" && !Array.isArray(visibility)
        ? [
            {
              domain:
                text((visibility as Record<string, unknown>).domain) ??
                "jira-role",
              principalId:
                text((visibility as Record<string, unknown>).principalId) ??
                "unresolved",
              effect: "allow" as const,
            },
          ]
        : undefined;
    chunks.push({
      stableKey: `comment:${id}`,
      kind: "comment",
      text: body,
      location: {
        commentId: id,
        ...(text(comment.author) ? { author: text(comment.author) } : {}),
        ...(text(comment.createdAt)
          ? { createdAt: text(comment.createdAt) }
          : {}),
      },
      ...(aclOverride ? { aclOverride } : {}),
    });
  }
  return chunks;
}

function code(item: ValidatedSourceItem): NormalizedChunk[] {
  const symbols = records(item.metadata.symbols);
  if (symbols.length > 0) {
    return symbols.flatMap((symbol, ordinal) => {
      const body = text(symbol.text);
      if (!body) return [];
      const name = text(symbol.name) ?? `anonymous-${ordinal}`;
      const kind = text(symbol.kind) ?? "symbol";
      return [
        {
          stableKey: `symbol:${kind}:${name}`,
          kind: "symbol" as const,
          text: body,
          location: {
            name,
            symbolKind: kind,
            ...(integer(symbol.startLine) !== undefined
              ? { startLine: integer(symbol.startLine) }
              : {}),
            ...(integer(symbol.endLine) !== undefined
              ? { endLine: integer(symbol.endLine) }
              : {}),
            ...(text(item.metadata.path)
              ? { path: text(item.metadata.path) }
              : {}),
          },
        },
      ];
    });
  }

  const lines = item.body.split("\n");
  const windowSize = 200;
  const chunks: NormalizedChunk[] = [];
  for (let start = 0; start < lines.length; start += windowSize) {
    const body = lines
      .slice(start, start + windowSize)
      .join("\n")
      .trim();
    if (!body) continue;
    chunks.push({
      stableKey: `lines:${start + 1}`,
      kind: "line-window",
      text: body,
      location: {
        startLine: start + 1,
        endLine: Math.min(start + windowSize, lines.length),
        ...(text(item.metadata.path) ? { path: text(item.metadata.path) } : {}),
      },
    });
  }
  return chunks;
}

function files(item: ValidatedSourceItem): NormalizedChunk[] {
  const pages = records(item.metadata.pages);
  if (pages.length === 0) return fallback(item);
  return pages.flatMap((page, ordinal) => {
    const body = text(page.text);
    if (!body) return [];
    const pageNumber = integer(page.pageNumber) ?? ordinal + 1;
    return [
      {
        stableKey: `page:${pageNumber}`,
        kind: "page" as const,
        text: body,
        location: {
          pageNumber,
          ...(page.boundingBox ? { boundingBox: page.boundingBox } : {}),
        },
      },
    ];
  });
}

class Normalizer implements SourceNormalizer {
  constructor(
    readonly source: Source,
    private readonly implementation: (
      item: ValidatedSourceItem,
    ) => NormalizedChunk[],
  ) {}

  normalize(item: ValidatedSourceItem): NormalizedChunk[] {
    return this.implementation(item);
  }
}

const normalizers = new Map<Source, SourceNormalizer>([
  ["confluence", new Normalizer("confluence", confluence)],
  ["jira", new Normalizer("jira", jira)],
  ["git", new Normalizer("git", code)],
  ["bitbucket", new Normalizer("bitbucket", code)],
  ["files", new Normalizer("files", files)],
]);

export function normalizerFor(source: Source): SourceNormalizer {
  const normalizer = normalizers.get(source);
  if (!normalizer)
    throw new Error(`no normalizer registered for source: ${source}`);
  return normalizer;
}
