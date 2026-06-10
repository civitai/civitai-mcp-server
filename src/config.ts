import { z } from 'zod';

/**
 * Environment configuration. Parsed once at startup.
 *
 * CIVITAI_API_URL is the base for BOTH the REST (/api/v1) and tRPC (/api/trpc)
 * clients. In-cluster this is overridden to e.g. http://civitai-app:3000 so the
 * server talks to the internal service instead of public civitai.com.
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
  apiKey: z.string().min(1).optional(),
  transport: TransportEnum.default('http'),
  port: z.coerce.number().int().positive().default(3100),
  userId: z.coerce.number().int().positive().optional(),
  /** Max bytes for any server-side user-URL fetch / base64 decode (image upload). */
  uploadMaxBytes: z.coerce.number().int().positive().default(DEFAULT_UPLOAD_MAX_BYTES),
  /** Optional allowlist of hostnames the server may fetch user URLs from. */
  uploadAllowedHosts: z.array(z.string()).optional(),
  /** Optional allowlist of Host headers for MCP DNS-rebinding protection. */
  mcpAllowedHosts: z.array(z.string()).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Build a Config from a raw env-like record. Exported (rather than reading
 * process.env directly) so tests can exercise parsing without mutating globals.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse({
    apiUrl: env.CIVITAI_API_URL,
    apiKey: env.CIVITAI_API_KEY,
    transport: env.MCP_TRANSPORT,
    port: env.PORT,
    userId: env.CIVITAI_USER_ID,
    uploadMaxBytes: env.CIVITAI_UPLOAD_MAX_BYTES,
    uploadAllowedHosts: csvList(env.CIVITAI_UPLOAD_ALLOWED_HOSTS),
    mcpAllowedHosts: csvList(env.MCP_ALLOWED_HOSTS),
  });
}

let cached: Config | null = null;

/** Lazily parse and cache the process environment config. */
export function getConfig(): Config {
  if (!cached) cached = parseConfig(process.env);
  return cached;
}

/** Test helper: reset the cached config. */
export function resetConfigCache(): void {
  cached = null;
}
