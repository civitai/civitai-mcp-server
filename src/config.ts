import { z } from 'zod';

/**
 * Environment configuration. Parsed once at startup.
 *
 * CIVITAI_API_URL is the base for BOTH the REST (/api/v1) and tRPC (/api/trpc)
 * clients. In-cluster this is overridden to e.g. http://civitai-app:3000 so the
 * server talks to the internal service instead of public civitai.com.
 */
const TransportEnum = z.enum(['http', 'stdio']);

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
