import { parse as devalueParse } from 'devalue';

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
 *
 * Both unwraps additionally sniff the response format: the site is migrating its
 * tRPC response transformer from superjson to devalue PER POOL, and the two are
 * told apart by type alone - superjson always writes an OBJECT ({ json, meta? }),
 * devalue always writes a STRING. A pool can also fall back to superjson for a
 * single response, so the sniff is per payload, not per deployment.
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
    let error = err?.error;
    if (typeof error === 'string') {
      const decoded = tryDecodeDevalue(error);
      if (decoded.ok) error = decoded.value;
    }
    const inner = error?.json ?? error ?? err;
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

/**
 * Decode a devalue payload. Reported through a wrapper rather than a sentinel
 * because `devalue.stringify(undefined)` is the valid payload `"-1"`, so a bare
 * `undefined` return cannot be told apart from a successful decode.
 */
function tryDecodeDevalue(payload: string): { ok: true; value: any } | { ok: false } {
  try {
    return { ok: true, value: devalueParse(payload) };
  } catch {
    return { ok: false };
  }
}

/** Unwrap the nested tRPC result envelope, superjson or devalue. Exported for testing. */
export function unwrapTrpcResult(data: unknown): unknown {
  const d = data as
    | { result?: { data?: { json?: unknown } | unknown } }
    | undefined;
  const resultData = d?.result?.data;
  if (typeof resultData === 'string') {
    const decoded = tryDecodeDevalue(resultData);
    if (!decoded.ok) {
      throw new Error(
        // Describes the payload rather than quoting it: this message is copied
        // into the model's context and any MCP log. 8 chars separates `<!DOCTYP`
        // from `{"error"` from `eyJhbGci`, and is safe ONLY because the sole
        // credential any response carries is a JWT, whose first 8 characters are
        // structural. Re-check that premise before adding a procedure that
        // returns an opaque secret.
        `Unrecognized tRPC response payload: expected a superjson envelope or a devalue string, got a ${
          resultData.length
        }-character string starting ${JSON.stringify(resultData.slice(0, 8))}`
      );
    }
    return decoded.value;
  }
  if (resultData && typeof resultData === 'object' && 'json' in resultData) {
    return (resultData as { json?: unknown }).json;
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
