import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { browseTools } from '../src/tools/browse.js';
import { resetBrowsingLevelCache } from '../src/client/trpc.js';

/**
 * search_models against a fake /api/v1/models that behaves like the site: a
 * text query is ranked by relevance, `types` and `nsfw` are applied on the
 * server, and `limit` caps the page. The "3wolf" shape: 100 SFW LoRAs outrank
 * the two NSFW checkpoints the user is looking for.
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

const NSFW_IDS = [1627205, 1826479];
const FIXTURE = [
  ...Array.from({ length: 100 }, (_, i) => ({ id: 5000 + i, name: `3wolf lora ${i}`, type: 'LORA', nsfw: false })),
  { id: NSFW_IDS[0]!, name: '3WolfMondAI-SDG', type: 'Checkpoint', nsfw: true },
  { id: NSFW_IDS[1]!, name: '3WolfMondAI-LastSDG', type: 'Checkpoint', nsfw: true },
];

const SFW_NOTE = 'Results are limited to safe-for-work models.';
const US = { 'cf-ipcountry': 'US' };
const ON = { CIVITAI_API_URL: 'https://x.test', FORWARD_USER_BROWSING_LEVEL: 'true' };

function fakeModels(params: Record<string, unknown>) {
  let items = FIXTURE.filter((m) => params.nsfw === true || !m.nsfw);
  if (params.types) items = items.filter((m) => m.type === params.types);
  return { items: items.slice(0, Number(params.limit ?? 100)) };
}

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
    const id = path.match(/^\/models\/(\d+)$/)?.[1];
    if (id) return FIXTURE.find((m) => m.id === Number(id)) as never;
    return fakeModels(params as Record<string, unknown>) as never;
  });
  return { trpc, gets };
}

async function run(name: string, s: Services, args: Record<string, unknown> = {}) {
  const { schema, handler } = tools.get(name)!;
  return handler(z.object(schema).parse(args) as Record<string, unknown>, s);
}

function ids(res: ToolResult): number[] {
  return ((res.structuredContent as { models?: Array<{ id: number }> })?.models ?? []).map((m) => m.id);
}

const ALL = { showNsfw: true, browsingLevel: 31 };

beforeEach(() => resetBrowsingLevelCache());
afterEach(() => vi.restoreAllMocks());

describe('search_models applies type on the server, with a query', () => {
  it('query "3wolf" + type Checkpoint finds the checkpoints behind 100 higher-ranked LoRAs', async () => {
    const s = buildServices(parseConfig(ON), 'k', US);
    const { gets } = stub(s, ALL);
    const res = await run('search_models', s, { query: '3wolf', type: 'Checkpoint' });
    expect(ids(res)).toEqual(NSFW_IDS);
    expect(gets[0]!.params).toMatchObject({ query: '3wolf', types: 'Checkpoint', limit: 12 });
  });

  it('supportsGeneration is sent with a query too, and false sends nothing', async () => {
    const s = buildServices(parseConfig(ON), 'k', US);
    const { gets } = stub(s, ALL);
    await run('search_models', s, { query: '3wolf', supportsGeneration: true });
    await run('search_models', s, { query: '3wolf', supportsGeneration: false });
    expect(gets[0]!.params.supportsGeneration).toBe(true);
    expect(gets[1]!.params.supportsGeneration).toBeUndefined();
  });

  it('the caller limit is sent as given', async () => {
    const s = buildServices(parseConfig(ON), 'k', US);
    const { gets } = stub(s, ALL);
    await run('search_models', s, { query: '3wolf', type: 'LORA', limit: 30 });
    expect(gets[0]!.params.limit).toBe(30);
  });

  it('baseModel is sent as baseModels', async () => {
    const s = buildServices(parseConfig(ON), 'k', US);
    const { gets } = stub(s, ALL);
    await run('search_models', s, { query: '3wolf', baseModel: 'NoobAI' });
    expect(gets[0]!.params.baseModels).toBe('NoobAI');
  });
});

describe('no mature result unless the user allows every level', () => {
  // Positive control: the fake server does hand out the NSFW checkpoints when
  // asked, so every "no leak" case below is able to fail.
  it('control: L=31, switch on, own key, Cloudflare -> both checkpoints, no SFW note', async () => {
    const s = buildServices(parseConfig(ON), 'k', US);
    stub(s, ALL);
    const res = await run('search_models', s, { query: '3wolf', type: 'Checkpoint' });
    expect(ids(res)).toEqual(NSFW_IDS);
    expect(res.content[0]!.text).not.toContain(SFW_NOTE);
  });

  const cases: Array<[string, () => Services, unknown]> = [
    ['anonymous', () => buildServices(parseConfig(ON), undefined, US), ALL],
    ['SFW user (showNsfw false)', () => buildServices(parseConfig(ON), 'k', US), { showNsfw: false, browsingLevel: 31 }],
    ['partial level 7', () => buildServices(parseConfig(ON), 'k', US), { showNsfw: true, browsingLevel: 7 }],
    ['partial level 30', () => buildServices(parseConfig(ON), 'k', US), { showNsfw: true, browsingLevel: 30 }],
    ['missing preference', () => buildServices(parseConfig(ON), 'k', US), {}],
    [
      'failed lookup',
      () => buildServices(parseConfig(ON), 'k', US),
      () => {
        throw new Error('boom');
      },
    ],
    ['switch off', () => buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }), 'k', US), ALL],
    ['not through Cloudflare', () => buildServices(parseConfig(ON), 'k', {}), ALL],
    ['env fallback key', () => buildServices(parseConfig({ ...ON, CIVITAI_API_KEY: 'svc' }), undefined, US), ALL],
  ];

  // Same args as the control, so a widened guard shows up as the two NSFW ids here.
  it.each(cases)('%s -> no NSFW model, no nsfw param, SFW note shown', async (_label, make, user) => {
    const s = make();
    const { gets } = stub(s, user);
    const res = await run('search_models', s, { query: '3wolf', type: 'Checkpoint' });
    expect(ids(res)).toEqual([]);
    expect(gets[0]!.params).not.toHaveProperty('nsfw');
    expect(res.content[0]!.text).toContain(SFW_NOTE);
  });

  it('SFW note is shown on an empty result too', async () => {
    const s = buildServices(parseConfig(ON), undefined, US);
    stub(s, ALL);
    const res = await run('search_models', s, { query: '3wolf', type: 'Checkpoint' });
    expect(ids(res)).toEqual([]);
    expect(res.content[0]!.text).toContain(SFW_NOTE);
  });
});

describe('mature models link to civitai.red when the site is civitai.com', () => {
  // The hosted shape: an in-cluster API URL, so links default to civitai.com.
  const HOSTED = { ...ON, CIVITAI_API_URL: 'http://civitai-app.internal:3000' };

  it('search_models: NSFW model -> civitai.red, SFW model -> civitai.com', async () => {
    const s = buildServices(parseConfig(HOSTED), 'k', US);
    stub(s, ALL);
    const text = [
      (await run('search_models', s, { query: '3wolf', type: 'Checkpoint' })).content[0]!.text,
      (await run('search_models', s, { query: '3wolf', type: 'LORA' })).content[0]!.text,
    ].join('\n');
    expect(text).toContain(`https://civitai.red/models/${NSFW_IDS[0]}`);
    expect(text).not.toContain(`https://civitai.com/models/${NSFW_IDS[0]}`);
    expect(text).toContain('https://civitai.com/models/5000');
    expect(text).not.toContain('https://civitai.red/models/5000');
  });

  it('get_model: NSFW model -> civitai.red, SFW model -> civitai.com', async () => {
    const s = buildServices(parseConfig(HOSTED), 'k', US);
    stub(s, ALL);
    const text = (await run('get_model', s, { ids: [NSFW_IDS[0], 5000] })).content[0]!.text;
    expect(text).toContain(`https://civitai.red/models/${NSFW_IDS[0]}`);
    expect(text).not.toContain(`https://civitai.com/models/${NSFW_IDS[0]}`);
    expect(text).toContain('https://civitai.com/models/5000');
    expect(text).not.toContain('https://civitai.red/models/5000');
  });

  it('any other site is left alone', async () => {
    const s = buildServices(parseConfig({ ...ON, CIVITAI_WEB_URL: 'https://dev.civitai.test' }), 'k', US);
    stub(s, ALL);
    const text = (await run('get_model', s, { ids: [NSFW_IDS[0]] })).content[0]!.text;
    expect(text).toContain(`https://dev.civitai.test/models/${NSFW_IDS[0]}`);
  });
});
