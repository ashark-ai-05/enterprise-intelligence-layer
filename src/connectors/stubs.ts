import type { IngestionScope, Source } from "../scopes/types.js";
import type {
  ConnectorBatch,
  ConnectorCursor,
  SourceConnector,
  SourceItem,
} from "./types.js";

export interface StubEvent {
  sequence: number;
  item: SourceItem;
}

function strings(selector: Record<string, unknown>, key: string): string[] {
  const value = selector[key];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function metadataString(item: SourceItem, key: string): string | undefined {
  const value = item.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function matchesConfluence(scope: IngestionScope, item: SourceItem): boolean {
  if (scope.selectorKind === "page") {
    return strings(scope.selector, "ids").includes(
      metadataString(item, "pageId") ?? "",
    );
  }
  if (scope.selectorKind === "space") {
    return strings(scope.selector, "keys").includes(
      metadataString(item, "spaceKey") ?? "",
    );
  }
  return false;
}

function matchesJira(scope: IngestionScope, item: SourceItem): boolean {
  if (scope.selectorKind === "issue") {
    return strings(scope.selector, "keys").includes(
      metadataString(item, "issueKey") ?? "",
    );
  }
  if (scope.selectorKind === "project") {
    return strings(scope.selector, "keys").includes(
      metadataString(item, "projectKey") ?? "",
    );
  }
  return false;
}

function matchesRepository(scope: IngestionScope, item: SourceItem): boolean {
  if (scope.selectorKind !== "repo" && scope.selectorKind !== "repository")
    return false;
  const repositories = [
    ...strings(scope.selector, "ids"),
    ...strings(scope.selector, "repositories"),
  ];
  if (!repositories.includes(metadataString(item, "repository") ?? ""))
    return false;
  const refs = strings(scope.selector, "refs");
  if (refs.length > 0 && !refs.includes(metadataString(item, "ref") ?? ""))
    return false;
  const prefix =
    typeof scope.selector.pathPrefix === "string"
      ? scope.selector.pathPrefix
      : undefined;
  return !prefix || (metadataString(item, "path") ?? "").startsWith(prefix);
}

function matchesFiles(scope: IngestionScope, item: SourceItem): boolean {
  if (scope.selectorKind === "file") {
    return strings(scope.selector, "paths").includes(
      metadataString(item, "path") ?? "",
    );
  }
  if (scope.selectorKind === "path") {
    const roots = strings(scope.selector, "roots");
    const path = metadataString(item, "path") ?? "";
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
  }
  return false;
}

type Matcher = (scope: IngestionScope, item: SourceItem) => boolean;

export class StubConnector implements SourceConnector {
  private readonly events: StubEvent[];

  constructor(
    readonly name: string,
    readonly source: Source,
    private readonly matches: Matcher,
    events: StubEvent[] = [],
  ) {
    this.events = [...events].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  append(...events: StubEvent[]): void {
    this.events.push(...events);
    this.events.sort((left, right) => left.sequence - right.sequence);
  }

  async read(
    scope: IngestionScope,
    cursor: ConnectorCursor | null,
  ): Promise<ConnectorBatch> {
    const sequence = cursor?.sequence ?? 0;
    const matching = this.events.filter(
      (event) => event.sequence > sequence && this.matches(scope, event.item),
    );
    const nextSequence = matching.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      sequence,
    );
    return {
      items: matching.map(({ item }) => item),
      nextCursor: { sequence: nextSequence },
      complete: true,
    };
  }

  async listCurrentIds(scope: IngestionScope): Promise<string[]> {
    const latest = new Map<string, StubEvent>();
    for (const event of this.events) {
      if (!this.matches(scope, event.item)) continue;
      const current = latest.get(event.item.sourceObjectId);
      if (!current || event.sequence > current.sequence)
        latest.set(event.item.sourceObjectId, event);
    }
    return [...latest.values()]
      .filter(({ item }) => !item.deleted)
      .map(({ item }) => item.sourceObjectId)
      .sort();
  }
}

export class StubConfluenceConnector extends StubConnector {
  constructor(events: StubEvent[] = []) {
    super("stub-confluence", "confluence", matchesConfluence, events);
  }
}

export class StubJiraConnector extends StubConnector {
  constructor(events: StubEvent[] = []) {
    super("stub-jira", "jira", matchesJira, events);
  }
}

export class StubGitConnector extends StubConnector {
  constructor(source: "git" | "bitbucket" = "git", events: StubEvent[] = []) {
    super(`stub-${source}`, source, matchesRepository, events);
  }
}

export class StubFilesConnector extends StubConnector {
  constructor(events: StubEvent[] = []) {
    super("stub-files", "files", matchesFiles, events);
  }
}
