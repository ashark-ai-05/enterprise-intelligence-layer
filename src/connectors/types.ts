import { z } from "zod";
import type { IngestionScope, Source } from "../scopes/types.js";

export const aceSchema = z.object({
  domain: z.string().min(1),
  principalId: z.string().min(1),
  effect: z.enum(["allow", "deny"]),
});

export const sourceItemSchema = z.object({
  sourceObjectId: z.string().min(1),
  sourceVersion: z.string().min(1),
  canonicalUri: z.string().url(),
  title: z.string().min(1),
  body: z.string(),
  metadata: z.record(z.unknown()),
  acl: z.array(aceSchema),
  sourceUpdatedAt: z.string().datetime({ offset: true }),
  deleted: z.boolean().default(false),
});

export const connectorCursorSchema = z.object({
  sequence: z.number().int().nonnegative(),
});

export type AccessControlEntry = z.infer<typeof aceSchema>;
export type SourceItem = z.input<typeof sourceItemSchema>;
export type ValidatedSourceItem = z.output<typeof sourceItemSchema>;

export type ConnectorCursor = z.infer<typeof connectorCursorSchema> &
  Record<string, unknown>;

export interface ConnectorBatch {
  items: SourceItem[];
  nextCursor: ConnectorCursor;
  complete: boolean;
}

export interface SourceConnector {
  readonly name: string;
  readonly source: Source;
  read(
    scope: IngestionScope,
    cursor: ConnectorCursor | null,
  ): Promise<ConnectorBatch>;
  listCurrentIds(scope: IngestionScope): Promise<string[]>;
}
