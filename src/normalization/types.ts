import type {
  AccessControlEntry,
  ValidatedSourceItem,
} from "../connectors/types.js";
import type { Source } from "../scopes/types.js";

export interface NormalizedChunk {
  stableKey: string;
  kind: "section" | "comment" | "symbol" | "line-window" | "page";
  text: string;
  location: Record<string, unknown>;
  aclOverride?: AccessControlEntry[];
}

export interface SourceNormalizer {
  readonly source: Source;
  normalize(item: ValidatedSourceItem): NormalizedChunk[];
}
