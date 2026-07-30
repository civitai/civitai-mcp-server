import { z } from 'zod';

/**
 * Environment configuration. Parsed once at startup.
 *
 * CIVITAI_API_URL is the base for BOTH the REST (/api/v1) and tRPC (/api/trpc)
 * clients. In-cluster this is overridden to e.g. http://civitai-app:3000 so the
 * server talks to the internal service instead of public civitai.com.
 *
 * CIVITAI_WEB_URL is the SEPARATE public website base used to build user-facing
 * links in tool output (post/model/image/article URLs). It must stay public even
 * when apiUrl points at an internal cluster service — otherwise tools would hand
 * users un-clickable in-cluster URLs. Default https://civitai.com.
 */
const TransportEnum = z.enum(['http', 'stdio']);

/** Parse a comma-separated env list into a trimmed, lowercased, deduped array. */
function csvList(raw: string | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const ConfigSchema = z.object({
  apiUrl: z
    .string()
    .url()
    .default('https://civitai.com')
    .transform((u) => u.replace(/\/+$/, '')),
  /**
   * Public website base for user-facing links in tool output (post/model/image/
   * profile URLs). Distinct from apiUrl: apiUrl may be an internal cluster service,
   * but links handed to users must point at the public site. Default civitai.com.
   */
  webUrl: z
    .string()
    .url()
    .default('https://civitai.com')
    .transform((u) => u.replace(/\/+$/, '')),
  /**
   * An MCP client configured with `"CIVITAI_API_KEY": "${CIVITAI_API_KEY}"` passes
   * that string through verbatim when the launching process has no such variable.
   * `.min(1)` accepted the 18-char literal and it went out as a bearer token, so
   * every call returned 401 "Please use the public API instead" — which reads as
   * Civitai blocking third-party tRPC rather than a local misconfiguration.
   *
   * Only the placeholder is rejected here. Key *shape* is warned about in
   * parseConfig instead: a wrong guess at Civitai's key format would refuse to
   * start with a perfectly valid key, which is worse than the warning.
   */
  apiKey: z
    .string()
    .min(1)
    .refine((k) => !/^\$[{(]/.test(k), {
      message:
        'CIVITAI_API_KEY is an unexpanded "${CIVITAI_API_KEY}" literal, not a key. The ' +
        'process that launched this server had no CIVITAI_API_KEY — export it in the ' +
        'launching shell, or set the value directly in your MCP client config.',
    })
    .optional(),
  transport: TransportEnum.default('http'),
  port: z.coerce.number().int().positive().default(3100),
  userId: z.coerce.number().int().positive().optional(),
  /** Max bytes for any server-side user-URL fetch / base64 decode (image upload). */
  uploadMaxBytes: z.coerce.number().int().positive().default(DEFAULT_UPLOAD_MAX_BYTES),
  /** Optional allowlist of hostnames the server may fetch user URLs from. */
  uploadAllowedHosts: z.array(z.string()).optional(),
  /** Optional allowlist of Host headers for MCP DNS-rebinding protection. */
  mcpAllowedHosts: z.array(z.string()).optional(),
  /**
   * Optional canonical public base URL (e.g. https://mcp.civitai.com). When set,
   * the advertised MCP endpoint / llms.txt / landing-page URLs use this instead
   * of deriving the origin from the request Host header. Useful when the server
   * sits behind a proxy that does not forward Host/X-Forwarded-* reliably, so the
   * hosted deployment always advertises its canonical address. Default: unset
   * (keep the Host-derivation behavior).
   */
  publicBaseUrl: z
    .string()
    .url()
    .optional()
    .transform((u) => (u ? u.replace(/\/+$/, '') : u)),
  /**
   * Gate for the one-click OAuth surface (RFC 9728 protected-resource metadata +
   * the 401 WWW-Authenticate challenge). Default OFF: until Civitai's OAuth
   * Dynamic Client Registration ships, an unauthenticated call to an auth-required
   * tool returns the normal "set CIVITAI_API_KEY" tool error instead of a 401 that
   * would bounce the client into an OAuth flow that dead-ends at the missing
   * register endpoint. Flip to true once DCR is live.
   */
  oauthEnabled: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === 'true' || v === '1'),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Build a Config from a raw env-like record. Exported (rather than reading
 * process.env directly) so tests can exercise parsing without mutating globals.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse({
    apiUrl: env.CIVITAI_API_URL,
    webUrl: env.CIVITAI_WEB_URL,
    apiKey: env.CIVITAI_API_KEY,
    transport: env.MCP_TRANSPORT,
    port: env.PORT,
    userId: env.CIVITAI_USER_ID,
    uploadMaxBytes: env.CIVITAI_UPLOAD_MAX_BYTES,
    uploadAllowedHosts: csvList(env.CIVITAI_UPLOAD_ALLOWED_HOSTS),
    mcpAllowedHosts: csvList(env.MCP_ALLOWED_HOSTS),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    oauthEnabled: env.OAUTH_ENABLED,
  });
}

let cached: Config | null = null;

/** Lazily parse and cache the process environment config. */
/** Shape of every Civitai personal API key seen so far. Warn only — never reject. */
const LIKELY_API_KEY = /^[a-f0-9]{32}$/i;

export function getConfig(): Config {
  if (!cached) {
    cached = parseConfig(process.env);
    // Startup-only diagnostic, so parseConfig stays pure for tests. A key of an
    // unexpected shape still works; it just gets a pointer to check here first,
    // because Civitai's 401 body sends people off to rewrite against /api/v1.
    const key = cached.apiKey;
    if (key && !LIKELY_API_KEY.test(key)) {
      console.error(
        `civitai-mcp: CIVITAI_API_KEY is ${key.length} chars, expected 32 hex. Continuing — ` +
          'but if calls return 401 "Please use the public API instead", suspect the key first.'
      );
    }
  }
  return cached;
}

/** Test helper: reset the cached config. */
export function resetConfigCache(): void {
  cached = null;
}
