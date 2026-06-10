import type { Config } from '../config.js';
import { AuthContext } from '../client/auth.js';
import { RestClient } from '../client/rest.js';
import { TrpcClient, TrpcError } from '../client/trpc.js';

/** Per-request service bundle. Built fresh per MCP request so each can carry
 *  its own Authorization header (multi-tenant in HTTP mode). */
export interface Services {
  config: Config;
  auth: AuthContext;
  rest: RestClient;
  trpc: TrpcClient;
}

export function buildServices(config: Config, requestKey?: string): Services {
  const auth = new AuthContext(config, requestKey);
  return {
    config,
    auth,
    rest: new RestClient(auth),
    trpc: new TrpcClient(auth),
  };
}

/** MCP tool result shape (subset we use). The index signature keeps it
 *  structurally compatible with the SDK's CallToolResult type. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Build a successful tool result with both a text block and structured JSON. */
export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (structured) result.structuredContent = structured;
  return result;
}

/** Build an error tool result. Never throws; folds zodError details into text. */
export function fail(error: unknown): ToolResult {
  let message: string;
  let details: unknown;
  if (error instanceof TrpcError) {
    message = error.message;
    details = error.zodError;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  const structured: Record<string, unknown> = { ok: false, error: message };
  if (details !== undefined) structured.details = details;
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    structuredContent: structured,
    isError: true,
  };
}

/**
 * Wrap an async handler so it always returns a normalized ToolResult and never
 * throws raw. The error path surfaces zodError details when present.
 */
export function handler<T>(
  fn: (args: T, services: Services) => Promise<ToolResult>
): (args: T, services: Services) => Promise<ToolResult> {
  return async (args, services) => {
    try {
      return await fn(args, services);
    } catch (err) {
      return fail(err);
    }
  };
}

/** Run async tasks with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>
): Promise<Array<{ ok: true; value: O } | { ok: false; error: string; item: I }>> {
  const results: Array<{ ok: true; value: O } | { ok: false; error: string; item: I }> = new Array(
    items.length
  );
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i]!, i) };
      } catch (err) {
        results[i] = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          item: items[i]!,
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
