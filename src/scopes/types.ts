import { z } from "zod";

export const sourceSchema = z.enum([
  "confluence",
  "jira",
  "bitbucket",
  "git",
  "files",
]);
export const refreshModeSchema = z.enum([
  "snapshot",
  "manual",
  "scheduled",
  "continuous",
]);

export const createScopeSchema = z
  .object({
    tenantId: z.string().min(1),
    source: sourceSchema,
    selectorKind: z.string().min(1),
    selector: z.record(z.unknown()),
    refreshMode: refreshModeSchema.default("manual"),
    includeChildren: z.boolean().default(false),
    includeAttachments: z.boolean().default(true),
    schedule: z.string().min(1).optional(),
    addedBy: z.string().min(1),
    deletionPolicy: z.enum(["retain", "purge"]).default("retain"),
  })
  .superRefine((scope, context) => {
    if (scope.refreshMode === "scheduled" && !scope.schedule) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule"],
        message: "scheduled scopes require a schedule",
      });
    }
    if (scope.refreshMode !== "scheduled" && scope.schedule) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule"],
        message: "schedule is only valid for scheduled scopes",
      });
    }
  });

export type CreateScope = z.input<typeof createScopeSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type RefreshMode = z.infer<typeof refreshModeSchema>;

export interface IngestionScope {
  id: string;
  tenantId: string;
  source: Source;
  selectorKind: string;
  selector: Record<string, unknown>;
  refreshMode: RefreshMode;
  includeChildren: boolean;
  includeAttachments: boolean;
  schedule: string | null;
  enabled: boolean;
  addedBy: string;
  configVersion: number;
  cursor: Record<string, unknown> | null;
  lastStatus: string | null;
  deletionPolicy: "retain" | "purge";
}
