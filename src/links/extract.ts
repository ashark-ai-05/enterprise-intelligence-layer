import type { SourceLink, ValidatedSourceItem } from "../connectors/types.js";
import { stableJson } from "../ingestion/hash.js";
import type { Source } from "../scopes/types.js";

export type LinkOrigin =
  | "source-explicit"
  | "deterministic-extracted"
  | "inferred";

export interface ExtractedResourceLink extends SourceLink {
  origin: LinkOrigin;
  extractorVersion: string;
  confidence: number;
}

const EXTRACTOR_VERSION = "deterministic-links-v1";

function extracted(
  source: Source,
  sourceObjectId: string,
  type: SourceLink["type"],
): ExtractedResourceLink {
  return {
    source,
    sourceObjectId,
    type,
    origin: "deterministic-extracted",
    extractorVersion: EXTRACTOR_VERSION,
    confidence: 0.95,
  };
}

export function extractResourceLinks(
  source: Source,
  item: ValidatedSourceItem,
): ExtractedResourceLink[] {
  const links: ExtractedResourceLink[] = item.links.map((link) => ({
    ...link,
    origin: "source-explicit",
    extractorVersion: "source-link-v1",
    confidence: 1,
  }));
  const searchable = `${item.body}\n${stableJson(item.metadata)}`;

  for (const match of searchable.matchAll(/\bCONF-\d+\b/g)) {
    const id = match[0];
    if (source !== "confluence" || id !== item.sourceObjectId) {
      links.push(extracted("confluence", id, "documents"));
    }
  }

  for (const match of searchable.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) {
    const id = match[0];
    if (id.startsWith("CONF-")) continue;
    if (source !== "jira" || id !== item.sourceObjectId) {
      links.push(extracted("jira", id, "documents"));
    }
  }

  for (const match of searchable.matchAll(
    /\b(service-\d+)\/(src\/[A-Za-z0-9._/-]+)\b/g,
  )) {
    links.push(extracted("git", `${match[1]}:${match[2]}`, "implemented-by"));
  }

  const unique = new Map<string, ExtractedResourceLink>();
  for (const link of links) {
    const key = [
      link.source,
      link.sourceObjectId,
      link.type,
      link.origin,
      link.extractorVersion,
    ].join("\u0000");
    unique.set(key, link);
  }
  return [...unique.values()].sort((left, right) =>
    stableJson(left).localeCompare(stableJson(right)),
  );
}
