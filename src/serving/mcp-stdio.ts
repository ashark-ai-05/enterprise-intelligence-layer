/**
 * MCP over stdio.
 *
 * The protocol is JSON-RPC 2.0 in newline-delimited JSON, and the surface we
 * need is three methods: `initialize`, `tools/list`, `tools/call`. That is
 * implemented directly here rather than by adding the MCP SDK, because a new
 * dependency is a new thing that must resolve through a corporate npm mirror —
 * and the whole point of stdio mode is that it needs no approvals.
 *
 * Personal mode is where adoption actually happens: it plugs into the tools
 * people already have open (Amp, Copilot, Claude Code) rather than asking them
 * to visit a new web app. Each user runs their own process, so the OS user is a
 * sound identity.
 *
 * → docs/08-serving-and-front-doors.md §3.1
 */

import { TOOLS, type ToolContext, ToolError, callTool } from "./tools.js";

export const PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

/** JSON-RPC reserved codes. */
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * Handle one request.
 *
 * Returns `null` for a notification — a message with no `id` expects no reply,
 * and answering one corrupts the stream.
 */
export async function handleRequest(
  request: JsonRpcRequest,
  context: ToolContext,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  const isNotification = request.id === undefined;

  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "eil", version: "0.1.0" },
      },
    };
  }

  if (
    request.method === "notifications/initialized" ||
    request.method === "initialized"
  ) {
    return null;
  }

  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const name = params.name;
    if (typeof name !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: INVALID_PARAMS, message: "name is required" },
      };
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await callTool(name, args, context);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: result.content }],
          ...(result.isError === true ? { isError: true } : {}),
        },
      };
    } catch (error) {
      // A tool failure is a *result* with isError, not a transport error: the
      // model should see what went wrong and be able to try something else,
      // rather than the client treating the server as broken.
      const message =
        error instanceof ToolError ? error.message : "internal error";
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: message }], isError: true },
      };
    }
  }

  if (isNotification) return null;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: METHOD_NOT_FOUND,
      message: `unknown method: ${request.method}`,
    },
  };
}

/** Parse one line and handle it. Malformed JSON gets a response, never a crash. */
export async function handleLine(
  line: string,
  context: ToolContext,
): Promise<string | null> {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
  }

  const response = await handleRequest(request, context);
  return response === null ? null : JSON.stringify(response);
}

export interface ServeOptions {
  readonly input?: AsyncIterable<string | Buffer>;
  readonly write?: (line: string) => void;
}

/**
 * Read newline-delimited JSON-RPC from stdin and write responses to stdout.
 *
 * Requests are handled **in order**. Concurrency here would let a slow search
 * reorder responses relative to requests, and under the embedded storage
 * profile there is a single database connection anyway.
 */
export async function serveStdio(
  context: ToolContext,
  options: ServeOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const write =
    options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const response = await handleLine(line, context);
      if (response !== null) write(response);
      newline = buffer.indexOf("\n");
    }
  }

  if (buffer.trim() !== "") {
    const response = await handleLine(buffer, context);
    if (response !== null) write(response);
  }
}
