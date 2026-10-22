import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, servicesFromHeaders, type Services, type ToolResult } from '../src/tools/helpers.js';
import { browseTools } from '../src/tools/browse.js';
import { browsingLevelFromUser, resetBrowsingLevelCache } from '../src/client/trpc.js';
import { regionHeadersFrom } from '../src/client/auth.js';

/**
 * Search tools must carry the CALLING user's own browsing level, never wider.
 * No user, no preference, or a failed lookup sends nothing (site default).
 */
type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

function collect(mod: (reg: never) => void): Map<string, { schema: ZodRawShape; handler: Handler }> {
  const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
  const reg = ((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
    tools.set(name, { schema: config.inputSchema ?? {}, handler });
  }) as unknown as never;
  mod(reg);
  return tools;
}

const tools = collect(browseTools);

const US = { 'cf-ipcountry': 'US' };

const ON = { CIVITAI_API_URL: 'https://x.test', FORWARD_USER_BROWSING_LEVEL: 'true' };

/** Switch on, HTTP mode, the key sent on the request (the caller's own), cf-ipcountry present. */
function svc(key: string | null = 'k', region: Record<string, string> = US): Services {
  return buildServices(parseConfig(ON), key ?? undefined, region);
}

/** Stub auth.getUser (the only tRPC call browse tools make) and every REST GET. */
function stub(s: Services, user: unknown | (() => never)) {
  const trpc = vi.spyOn(s.trpc, 'call').mockImplementation(async (procedure: string) => {
    if (procedure !== 'auth.getUser') throw new Error(`unexpected ${procedure}`);
    if (typeof user === 'function') return (user as () => never)();
    return user as never;
  });
  vi.spyOn(s.rest, 'fetchEnums').mockResolvedValue({});
  const gets: Array<{ path: string; params: Record<string, unknown> }> = [];
  vi.spyOn(s.rest, 'get').mockImplementation(async (path: string, params = {}) => {
    gets.push({ path, params: params as Record<string, unknown> });
    return { items: [{ id: 1, name: 'x' }] } as never;
  });
  return { trpc, gets };
}

async function run(name: string, s: Services, args: Record<string, unknown> = {}) {
  const { schema, handler } = tools.get(name)!;
  return handler(z.object(schema).parse(args) as Record<string, unknown>, s);
}

beforeEach(() => resetBrowsingLevelCache());
afterEach(() => vi.restoreAllMocks());

describe('browsingLevelFromUser mirrors the site rule (showNsfw && level ? level : PG)', () => {
  it.each([
    [{ showNsfw: true, browsingLevel: 31 }, 31],
    [{ showNsfw: true, browsingLevel: 7 }, 7],
    [{ showNsfw: false, browsingLevel: 31 }, 1],
    [{ showNsfw: true, browsingLevel: 0 }, 1],
    // Bits above XXX (Blocked = 32) are masked off, never passed through.
    [{ showNsfw: true, browsingLevel: 63 }, 31],
    [{ showNsfw: true, browsingLevel: 32 }, 1],
  ])('%j -> %i', (user, level) => {
    expect(browsingLevelFromUser(user)).toBe(level);
  });

  it.each([null, undefined, {}, { showNsfw: true }, { browsingLevel: 31 }, { showNsfw: 'yes', browsingLevel: 31 }])(
    'no usable preference (%j) -> undefined',
    (user) => {
      expect(browsingLevelFromUser(user)).toBeUndefined();
    }
  );
});

describe('search_images / get_image send the user level', () => {
  it('search_images sends browsingLevel=L', async () => {
    const s = svc();
    const { gets } = stub(s, { showNsfw: true, browsingLevel: 3 });
    await run('search_images', s);
    expect(gets[0]!.params.browsingLevel).toBe(3);
  });

  it('get_image sends browsingLevel=L on every id', async () => {
    const s = svc();
    const { gets } = stub(s, { showNsfw: true, browsingLevel: 7 });
    await run('get_image', s, { ids: [10, 11] });
    expect(gets.map((g) => g.params.browsingLevel)).toEqual([7, 7]);
  });

  it('a showNsfw:false user gets PG, not their saved level', async () => {
    const s = svc();
    const { gets } = stub(s, { showNsfw: false, browsingLevel: 31 });
    await run('search_images', s);
    expect(gets[0]!.params.browsingLevel).toBe(1);
  });
});

describe('search_models: nsfw=true only when the user allows every level', () => {
  it('L=31 -> nsfw=true', async () => {
    const s = svc();
    const { gets } = stub(s, { showNsfw: true, browsingLevel: 31 });
    await run('search_models', s);
    expect(gets[0]!.params.nsfw).toBe(true);
  });

  it.each([1, 3, 15, 30])('L=%i -> no nsfw param (strict narrowing)', async (level) => {
    const s = svc();
    const { gets } = stub(s, { showNsfw: true, browsingLevel: level });
    await run('search_models', s);
    expect(gets[0]!.params).not.toHaveProperty('nsfw');
  });
});

describe('fails closed to no param, never to max', () => {
  it('lookup throws -> search still runs, no level sent', async () => {
    const s = svc();
    const { gets } = stub(s, () => {
      throw new Error('boom');
    });
    await run('search_images', s);
    await run('search_models', s);
    expect(gets[0]!.params.browsingLevel).toBeUndefined();
    expect(gets[1]!.params).not.toHaveProperty('nsfw');
  });

  // keyIsCaller is false whenever there is no key, so this pins the pair, not `!key` alone.
  it('no API key -> no lookup, no level sent', async () => {
    const s = svc(null);
    const { trpc, gets } = stub(s, { showNsfw: true, browsingLevel: 31 });
    await run('search_images', s);
    expect(trpc).not.toHaveBeenCalled();
    expect(gets[0]!.params.browsingLevel).toBeUndefined();
  });

  it('HTTP request on the env fallback key gets no level: that is the deployment account', async () => {
    const s = buildServices(parseConfig({ ...ON, CIVITAI_API_KEY: 'service' }), undefined, US);
    const { trpc, gets } = stub(s, { showNsfw: true, browsingLevel: 31 });
    await run('search_images', s);
    await run('search_models', s);
    expect(trpc).not.toHaveBeenCalled();
    expect(gets[0]!.params.browsingLevel).toBeUndefined();
    expect(gets[1]!.params).not.toHaveProperty('nsfw');
  });

  // Pinned on purpose: a request that did not come through Cloudflare uses the site default.
  it('non-Cloudflare request -> no lookup, no level param', async () => {
    const s = svc('k', { 'cf-region-code': 'CA', 'x-isuk': '0' });
    const { trpc, gets } = stub(s, { showNsfw: true, browsingLevel: 31 });
    await run('search_images', s);
    await run('search_models', s);
    expect(trpc).not.toHaveBeenCalled();
    expect(gets[0]!.params.browsingLevel).toBeUndefined();
    expect(gets[1]!.params).not.toHaveProperty('nsfw');
  });

  it('stdio has no incoming request headers, so no level either', async () => {
    const s = buildServices(parseConfig({ ...ON, CIVITAI_API_KEY: 'mine', MCP_TRANSPORT: 'stdio' }));
    const { trpc, gets } = stub(s, { showNsfw: true, browsingLevel: 7 });
    await run('search_images', s);
    expect(trpc).not.toHaveBeenCalled();
    expect(gets[0]!.params.browsingLevel).toBeUndefined();
  });

  it('anonymous getUser (null) -> no level sent', async () => {
    const s = svc();
    const { gets } = stub(s, null);
    await run('search_images', s);
    expect(gets[0]!.params.browsingLevel).toBeUndefined();
  });
});

describe('level cache (60s TTL, per key, across requests)', () => {
  it('second request with the same key inside 60s does not re-query', async () => {
    vi.useFakeTimers();
    try {
      const a = svc('same');
      const { trpc: t1 } = stub(a, { showNsfw: true, browsingLevel: 3 });
      await run('search_images', a);
      const b = svc('same');
      const { trpc: t2, gets } = stub(b, { showNsfw: true, browsingLevel: 31 });
      await run('search_images', b);
      expect(t1).toHaveBeenCalledTimes(1);
      expect(t2).not.toHaveBeenCalled();
      expect(gets[0]!.params.browsingLevel).toBe(3);

      vi.advanceTimersByTime(60_001);
      await run('search_images', b);
      expect(t2).toHaveBeenCalledTimes(1);
      expect(gets[1]!.params.browsingLevel).toBe(31);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a different key is looked up separately', async () => {
    const a = svc('key-a');
    stub(a, { showNsfw: true, browsingLevel: 31 });
    await run('search_images', a);
    const b = svc('key-b');
    const { trpc, gets } = stub(b, { showNsfw: true, browsingLevel: 1 });
    await run('search_images', b);
    expect(trpc).toHaveBeenCalledTimes(1);
    expect(gets[0]!.params.browsingLevel).toBe(1);
  });

  it('evicts the oldest key past 1000 entries, so the cache stays bounded', async () => {
    const lookup = async (key: string) => {
      const s = svc(key);
      const spy = vi.spyOn(s.trpc, 'call').mockResolvedValue({ showNsfw: true, browsingLevel: 3 } as never);
      await s.trpc.getBrowsingLevel();
      return spy.mock.calls.length;
    };
    for (let i = 0; i <= 1000; i++) await lookup(`key-${i}`);
    expect(await lookup('key-1000')).toBe(0);
    expect(await lookup('key-0')).toBe(1);
  });

  it('a failed lookup is not cached as a level', async () => {
    const a = svc('flaky');
    stub(a, () => {
      throw new Error('boom');
    });
    await run('search_images', a);
    const b = svc('flaky');
    const { trpc, gets } = stub(b, { showNsfw: true, browsingLevel: 3 });
    await run('search_images', b);
    expect(trpc).toHaveBeenCalledTimes(1);
    expect(gets[0]!.params.browsingLevel).toBe(3);
  });
});

// Pinned on purpose: the default (off) is the pre-feature behaviour exactly.
describe('FORWARD_USER_BROWSING_LEVEL off (the default)', () => {
  it('switch off -> no lookup, no level, no nsfw, even through Cloudflare', async () => {
    const s = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }), 'k', US);
    const { trpc, gets } = stub(s, { showNsfw: true, browsingLevel: 31 });
    await run('search_images', s);
    await run('search_models', s);
    await run('get_image', s, { ids: [1] });
    expect(trpc).not.toHaveBeenCalled();
    expect(gets[0]!.params.browsingLevel).toBeUndefined();
    expect(gets[1]!.params).not.toHaveProperty('nsfw');
    expect(gets[2]!.params.browsingLevel).toBeUndefined();
  });

  it('switch off -> region headers are not forwarded', () => {
    const s = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }), 'k', {
      'cf-ipcountry': 'GB',
      'x-isuk': '1',
    });
    expect(s.auth.regionHeaders).toEqual({});
  });
});

describe('region headers are forwarded unchanged to the site', () => {
  it('regionHeadersFrom keeps only the three region headers, values unchanged', () => {
    expect(
      regionHeadersFrom({
        'cf-ipcountry': 'GB',
        'cf-region-code': 'ENG',
        'x-isuk': '1',
        'cf-connecting-ip': '1.2.3.4',
        authorization: 'Bearer k',
      })
    ).toEqual({ 'cf-ipcountry': 'GB', 'cf-region-code': 'ENG', 'x-isuk': '1' });
    expect(regionHeadersFrom(undefined)).toEqual({});
  });

  it('switch on -> level sent and all three headers on every outbound call', async () => {
    const region = { 'cf-ipcountry': 'GB', 'cf-region-code': 'ENG', 'x-isuk': '1' };
    const s = svc('caller', region);
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        sent.push({ url, headers: init.headers });
        const body = url.includes('/api/trpc/auth.getUser')
          ? { result: { data: { json: { showNsfw: true, browsingLevel: 31 } } } }
          : url.includes('/enums')
            ? {}
            : { items: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    try {
      await run('search_images', s);
    } finally {
      vi.unstubAllGlobals();
    }
    const search = sent.find((c) => c.url.includes('/api/v1/images'))!;
    expect(new URL(search.url).searchParams.get('browsingLevel')).toBe('31');
    const lookup = sent.find((c) => c.url.includes('auth.getUser'))!;
    for (const call of [search, lookup]) {
      expect(call.headers).toMatchObject({ ...region, Authorization: 'Bearer caller' });
    }
  });
});

describe('servicesFromHeaders: the wiring server.ts uses per MCP request', () => {
  it('takes the bearer and the region headers from the incoming request', () => {
    const s = servicesFromHeaders(parseConfig(ON), {
      authorization: 'Bearer caller',
      'cf-ipcountry': 'GB',
      'x-isuk': '1',
      host: 'mcp.test',
    });
    expect(s.auth.apiKey).toBe('caller');
    expect(s.auth.keyIsCaller).toBe(true);
    expect(s.auth.regionHeaders).toEqual({ 'cf-ipcountry': 'GB', 'x-isuk': '1' });
  });

  it('no headers (stdio) -> env key, no region', () => {
    const s = servicesFromHeaders(parseConfig({ ...ON, CIVITAI_API_KEY: 'env' }), undefined);
    expect(s.auth.apiKey).toBe('env');
    expect(s.auth.regionHeaders).toEqual({});
  });
});

describe('level cache is keyed by key AND forwarded headers', () => {
  it('same key from another country is looked up again', async () => {
    const a = svc('one-key', { 'cf-ipcountry': 'US' });
    stub(a, { showNsfw: true, browsingLevel: 31 });
    await run('search_images', a);
    const b = svc('one-key', { 'cf-ipcountry': 'GB' });
    const { trpc, gets } = stub(b, { showNsfw: true, browsingLevel: 3 });
    await run('search_images', b);
    expect(trpc).toHaveBeenCalledTimes(1);
    expect(gets[0]!.params.browsingLevel).toBe(3);
  });
});

// Pinned on purpose: the hosted shape (in-cluster API URL, switch at its default)
// must send exactly what it sent before this feature, whatever headers arrive.
describe('hosted shape: in-cluster API URL, switch default', () => {
  // SFW models only: an nsfw:true model links to civitai.red (see search-models.test.ts).
  it('tool output links for SFW models stay on civitai.com', async () => {
    const s = servicesFromHeaders(parseConfig({ CIVITAI_API_URL: 'http://civitai-app.internal:3000' }), {
      authorization: 'Bearer caller',
    });
    vi.spyOn(s.rest, 'fetchEnums').mockResolvedValue({});
    vi.spyOn(s.rest, 'get').mockResolvedValue({ items: [{ id: 4201, name: 'm', type: 'LORA' }] } as never);
    const res = await run('search_models', s);
    const text = res.content[0]!.text;
    expect(text).toContain('https://civitai.com/models/4201');
    expect(text).not.toContain('civitai.red');
  });

  it('sends no level, no nsfw, no region headers and no user lookup', async () => {
    const s = servicesFromHeaders(parseConfig({ CIVITAI_API_URL: 'http://civitai-app.internal:3000' }), {
      authorization: 'Bearer caller',
      'cf-ipcountry': 'US',
      'cf-region-code': 'CA',
      'x-isuk': '0',
    });
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        sent.push({ url, headers: init.headers });
        return new Response(JSON.stringify(url.includes('/enums') ? {} : { items: [{ id: 1 }] }), { status: 200 });
      })
    );
    try {
      await run('search_images', s);
      await run('search_models', s);
      await run('get_image', s, { ids: [5] });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.some((c) => c.url.includes('auth.getUser'))).toBe(false);
    for (const call of sent) {
      const u = new URL(call.url);
      expect(u.origin).toBe('http://civitai-app.internal:3000');
      expect(u.searchParams.has('browsingLevel')).toBe(false);
      expect(u.searchParams.has('nsfw')).toBe(false);
      expect(Object.keys(call.headers).sort()).toEqual(['Authorization', 'Content-Type']);
    }
    expect(sent.filter((c) => c.url.includes('/api/v1/'))).toHaveLength(3);
  });
});
