import type { AuthContext } from './auth.js';

/**
 * Client for Civitai's public REST surface (/api/v1), ported from the
 * civitai-browse skill (browse.mjs). Auth is optional (enhances results) but
 * used when a key is available.
 *
 * Includes:
 *  - enum validation with a cached /enums fetch (case-insensitive match,
 *    returns the correctly-cased value).
 *  - the query+type Meilisearch bug workaround is implemented in the model
 *    search tool, which uses searchModelsRaw from here.
 */
export class RestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RestError';
    this.status = status;
  }
}

type QueryParams = Record<string, string | number | boolean | undefined | null>;

export class RestClient {
  private enumsCache: Record<string, unknown> | null = null;

  constructor(private readonly auth: AuthContext) {}

  private base(): string {
    return `${this.auth.apiUrl}/api/v1`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.auth.apiKey) h['Authorization'] = `Bearer ${this.auth.apiKey}`;
    return h;
  }

  /** GET an /api/v1 path with query params (undefined/empty values dropped). */
  async get<T = unknown>(path: string, params: QueryParams = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const url = `${this.base()}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RestError(`API ${res.status} ${res.statusText}: ${text.slice(0, 400)}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** POST an /api/v1 path with a JSON body. */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = `${this.base()}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RestError(`API ${res.status} ${res.statusText}: ${text.slice(0, 400)}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** Fetch and cache the /enums map. Returns {} on failure (validation skipped). */
  async fetchEnums(): Promise<Record<string, unknown>> {
    if (this.enumsCache) return this.enumsCache;
    try {
      this.enumsCache = await this.get<Record<string, unknown>>('/enums');
    } catch {
      this.enumsCache = {};
    }
    return this.enumsCache;
  }

  /**
   * Validate a value against an enum key. Returns the correctly-cased value on
   * a case-insensitive match. Throws with the allowed values on a miss. Returns
   * the input unchanged when the enum list is unavailable.
   */
  async validateEnum(label: string, value: string, enumKey: string): Promise<string> {
    const enums = await this.fetchEnums();
    const allowed = enums[enumKey];
    if (!Array.isArray(allowed)) return value; // can't validate, pass through
    const match = (allowed as string[]).find((v) => v.toLowerCase() === value.toLowerCase());
    if (!match) {
      const list = (allowed as string[]).slice(0, 20).join(', ');
      throw new Error(
        `Invalid ${label} value "${value}". Allowed (${enumKey}): ${list}${
          (allowed as string[]).length > 20 ? ', ...' : ''
        }`
      );
    }
    return match;
  }
}
