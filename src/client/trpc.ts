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
  /** The server's own error message, unprefixed — for callers that classify a refusal by it. */
  readonly serverMessage: string | undefined;
  constructor(message: string, status: number, zodError?: unknown, serverMessage?: string) {
    super(message);
    this.name = 'TrpcError';
    this.status = status;
    this.zodError = zodError;
    this.serverMessage = serverMessage;
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
  let serverMessage: string | undefined;
  try {
    const err = JSON.parse(bodyText);
    let error = err?.error;
    if (typeof error === 'string') {
      const decoded = tryDecodeDevalue(error);
      if (decoded.ok) error = decoded.value;
    }
    const inner = error?.json ?? error ?? err;
    if (inner?.message) {
      message = `${procedure}: ${inner.message}`;
      serverMessage = String(inner.message);
    }
    if (inner?.data?.zodError) {
      zodError = inner.data.zodError;
      message += '\nValidation errors:\n' + JSON.stringify(inner.data.zodError, null, 2);
    }
  } catch {
    if (bodyText) message += `\n${bodyText.slice(0, 500)}`;
  }
  return new TrpcError(message, status, zodError, serverMessage);
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
        // credential any response carries is a JWT (today: user.getToken),
        // whose first 8 characters are structural. Re-check that premise before
        // adding a procedure that returns an opaque secret.
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

/** NsfwLevel bits PG | PG13 | R | X | XXX. Blocked (32) and above are never sent. */
const ALL_BROWSING_LEVELS = 31;
const PUBLIC_BROWSING_LEVEL = 1;

/**
 * The site's own rule for a user on civitai.red: their saved level when they
 * have NSFW on, otherwise PG. Undefined when the user or either field is
 * missing, so the caller sends no level and the site default applies.
 */
export function browsingLevelFromUser(user: unknown): number | undefined {
  const u = user as { showNsfw?: unknown; browsingLevel?: unknown } | null | undefined;
  if (typeof u?.showNsfw !== 'boolean' || typeof u.browsingLevel !== 'number') return undefined;
  if (!u.showNsfw) return PUBLIC_BROWSING_LEVEL;
  return (u.browsingLevel & ALL_BROWSING_LEVELS) || PUBLIC_BROWSING_LEVEL;
}

/** True only when the user allows every level: the sole case /api/v1/models may get nsfw=true. */
export function allowsAllLevels(level: number | undefined): boolean {
  return level !== undefined && (level & ALL_BROWSING_LEVELS) === ALL_BROWSING_LEVELS;
}

// Services are built per MCP request, so the cache lives at module scope, keyed
// by the API key and forwarded headers. In memory only, never logged. Only
// successful lookups are cached.
const BROWSING_LEVEL_TTL_MS = 60_000;
const BROWSING_LEVEL_CACHE_MAX = 1000;
const browsingLevelCache = new Map<string, { level: number | undefined; expires: number }>();

/** Test helper: clear the browsing-level cache. */
export function resetBrowsingLevelCache(): void {
  browsingLevelCache.clear();
}

export class TrpcClient {
  constructor(private readonly auth: AuthContext) {}

  /**
   * Call a tRPC procedure. `method` is POST (mutations) or GET (queries).
   * `metaValues` carries optional superjson type hints.
   *
   * Returns `T | null`. Civitai answers `{"result":{"data":{"json":null}}}` for an
   * empty result rather than an empty object — e.g. `commentv2.getInfinite` on a
   * comment with no replies, or on an entity type it does not serve. Declaring
   * `Promise<T>` let every call site dereference the result unchecked, which
   * crashed `list_comments` with "Cannot read properties of null".
   */
  async call<T = unknown>(
    procedure: string,
    input: unknown,
    method: 'GET' | 'POST' = 'POST',
    metaValues?: MetaValues
  ): Promise<T | null> {
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

    const headers: Record<string, string> = {
      ...this.auth.regionHeaders,
      'Content-Type': 'application/json',
    };
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

  /**
   * The calling user's effective browsing level (see browsingLevelFromUser), or
   * undefined with no caller key, no preference, or a failed lookup. Never
   * throws: a search must run at the site default rather than fail or widen.
   * An HTTP request on the env fallback key gets no level: that key is the
   * deployment's account, whose preference is not the caller's. Requires
   * FORWARD_USER_BROWSING_LEVEL and a Cloudflare-fronted request.
   */
  async getBrowsingLevel(): Promise<number | undefined> {
    const key = this.auth.apiKey;
    if (!key || !this.auth.keyIsCaller || !this.auth.regionKnown()) return undefined;
    const cacheKey = JSON.stringify([key, this.auth.regionHeaders]);
    const hit = browsingLevelCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.level;

    let level: number | undefined;
    try {
      level = browsingLevelFromUser(await this.call('auth.getUser', undefined, 'GET'));
    } catch {
      return undefined;
    }
    browsingLevelCache.delete(cacheKey);
    if (browsingLevelCache.size >= BROWSING_LEVEL_CACHE_MAX) {
      browsingLevelCache.delete(browsingLevelCache.keys().next().value!);
    }
    browsingLevelCache.set(cacheKey, { level, expires: Date.now() + BROWSING_LEVEL_TTL_MS });
    return level;
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
