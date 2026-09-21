import type { AuthContext } from './auth.js';

/**
 * Minimal tRPC client for Civitai's /api/trpc surface, ported from the
 * civitai-user skill (lib.mjs). Key behaviors preserved:
 *
 *  - POST body / GET query is `{ json: input }` (superjson wrapper).
 *  - Optional `meta.values` type hints, e.g. { publishedAt: ['Date'] }, so
 *    z.date() fields deserialize as Date server-side instead of staying strings.
 *  - Error unwrap: err.error.json ?? err.error; surfaces data.zodError details.
 *  - Result unwrap: data.result.data.json ?? data.result.data ?? data.
 */

export type MetaValues = Record<string, string[]>;

/** Error thrown for any non-2xx tRPC response, with zodError details folded in. */
export class TrpcError extends Error {
  readonly status: number;
  readonly zodError: unknown;
  constructor(message: string, status: number, zodError?: unknown) {
    super(message);
    this.name = 'TrpcError';
    this.status = status;
    this.zodError = zodError;
  }
}

/**
 * Parse a tRPC error response body into a friendly message + zodError payload.
 * Exported for unit testing (no network involved).
 */
export function parseTrpcError(
  procedure: string,
  status: number,
  statusText: string,
  bodyText: string
): TrpcError {
  let message = `${procedure} failed: ${status} ${statusText}`;
  let zodError: unknown;
  try {
    const err = JSON.parse(bodyText);
    const inner = err?.error?.json ?? err?.error ?? err;
    if (inner?.message) message = `${procedure}: ${inner.message}`;
    if (inner?.data?.zodError) {
      zodError = inner.data.zodError;
      message += '\nValidation errors:\n' + JSON.stringify(inner.data.zodError, null, 2);
    }
  } catch {
    if (bodyText) message += `\n${bodyText.slice(0, 500)}`;
  }
  return new TrpcError(message, status, zodError);
}

/** Unwrap the nested tRPC/superjson result envelope. Exported for testing. */
export function unwrapTrpcResult(data: unknown): unknown {
  const d = data as
    | { result?: { data?: { json?: unknown } | unknown } }
    | undefined;
  const resultData = d?.result?.data as { json?: unknown } | undefined;
  if (resultData && typeof resultData === 'object' && 'json' in resultData) {
    return resultData.json;
  }
  return resultData ?? data;
}

export class TrpcClient {
  constructor(private readonly auth: AuthContext) {}

  /**
   * Call a tRPC procedure. `method` is POST (mutations) or GET (queries).
   * `metaValues` carries optional superjson type hints.
   */
  async call<T = unknown>(
    procedure: string,
    input: unknown,
    method: 'GET' | 'POST' = 'POST',
    metaValues?: MetaValues
  ): Promise<T> {
    // `?? null`: JSON.stringify({ json: undefined }) drops the key entirely and
    // emits `{}`, which Civitai's tRPC rejects with "Invalid input". Every
    // no-argument procedure (user.getSelfStatus, user.checkNotifications,
    // chat.getAllByUser, ...) hit that.
    const wrapped: { json: unknown; meta?: { values: MetaValues } } = { json: input ?? null };
    if (metaValues && Object.keys(metaValues).length > 0) {
      wrapped.meta = { values: metaValues };
    }

    const base = `${this.auth.apiUrl}/api/trpc/${procedure}`;
    const url =
      method === 'GET' ? `${base}?input=${encodeURIComponent(JSON.stringify(wrapped))}` : base;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = this.auth.apiKey;
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const res = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(wrapped) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw parseTrpcError(procedure, res.status, res.statusText, text);
    }

    const data = await res.json();
    return unwrapTrpcResult(data) as T;
  }

  /** Look up a user by numeric id or username. */
  async lookupUser(input: string | number): Promise<{ id: number; username: string } | null> {
    const isId = /^\d+$/.test(String(input));
    if (isId) {
      return this.call('user.getById', { id: Number(input) }, 'GET');
    }
    return this.call('user.getCreator', { username: String(input) }, 'GET');
  }

  /** Resolve the signed-in user's id from the API key via the user.getToken JWT. */
  async getSelfUserId(): Promise<number> {
    const cached = this.auth.getCachedSelfId();
    if (cached) return cached;

    const result = await this.call<{ token: string }>('user.getToken', undefined, 'GET');
    const token = result?.token;
    if (!token) throw new Error('user.getToken returned no token');
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('Malformed JWT from user.getToken');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as {
      userId?: number;
    };
    if (!payload.userId) throw new Error('Could not resolve user id from API key');
    this.auth.setSelfId(payload.userId);
    return payload.userId;
  }
}
