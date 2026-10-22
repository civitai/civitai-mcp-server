import type { Config } from '../config.js';

/**
 * Per-request authentication context. In HTTP mode each MCP request may carry
 * its own `Authorization: Bearer <key>` which overrides the env key (multi-tenant
 * in-cluster). The env key is the fallback. In stdio mode only the env key exists.
 *
 * Self-user-id resolution (user.getToken JWT decode) is cached per key so we
 * don't pay the round-trip on every user-action tool call.
 */
export class AuthContext {
  readonly apiKey: string | undefined;
  readonly apiUrl: string;
  /**
   * Whether apiKey is the CALLER's own key: sent with this request, or the env
   * key in stdio mode (one local user). An HTTP request that fell back to the
   * env key is the deployment's account, not the caller.
   */
  readonly keyIsCaller: boolean;
  /** Region headers of the incoming request, forwarded unchanged on every site call. Empty when FORWARD_USER_BROWSING_LEVEL is off. */
  readonly regionHeaders: Record<string, string>;
  private readonly configUserId: number | undefined;
  private cachedSelfId: number | undefined;

  constructor(config: Config, requestKey?: string, regionHeaders: Record<string, string> = {}) {
    this.apiUrl = config.apiUrl;
    this.apiKey = requestKey ?? config.apiKey;
    this.keyIsCaller = !!requestKey || (config.transport === 'stdio' && !!config.apiKey);
    this.regionHeaders = config.forwardUserBrowsingLevel ? regionHeaders : {};
    this.configUserId = config.userId;
  }

  /** Whether the request arrived through Cloudflare with the switch on. */
  regionKnown(): boolean {
    return !!this.regionHeaders['cf-ipcountry'];
  }

  /** Whether an API key is available for authenticated calls. */
  hasKey(): boolean {
    return !!this.apiKey;
  }

  /** Throw a clear error if no key is available (for auth-required tools). */
  requireKey(): string {
    if (!this.apiKey) {
      throw new Error(
        'No API key available. Set CIVITAI_API_KEY in the environment, or send an Authorization: Bearer <key> header with the MCP request.'
      );
    }
    return this.apiKey;
  }

  /** Cache a resolved self user id (called by the tRPC client). */
  setSelfId(id: number): void {
    this.cachedSelfId = id;
  }

  /** Read the cached/configured self user id, if any. */
  getCachedSelfId(): number | undefined {
    return this.cachedSelfId ?? this.configUserId;
  }
}

/** Region headers copied from the incoming request as received, never synthesised. */
const REGION_HEADERS = ['cf-ipcountry', 'cf-region-code', 'x-isuk'] as const;

/** Pick the region headers out of an incoming request's headers. */
export function regionHeadersFrom(
  headers: Record<string, string | string[] | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REGION_HEADERS) {
    const raw = headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) out[name] = value;
  }
  return out;
}

/** Extract a bearer token from an Authorization header value, if present. */
export function bearerFromHeader(headerValue: string | string[] | undefined): string | undefined {
  if (!headerValue) return undefined;
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : undefined;
}
