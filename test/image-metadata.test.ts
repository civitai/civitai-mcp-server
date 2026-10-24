import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { browseTools } from '../src/tools/browse.js';

/**
 * /api/v1/images serves an imageId lookup, and a modelId filter without a
 * modelVersionId, through its legacy path. There meta arrives as
 * { id, meta: {...} } unless flatMeta=true is sent (civitai
 * image-search.service.ts), so get_image printed an empty metadata section.
 */
type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
browseTools(((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
  tools.set(name, { schema: config.inputSchema ?? {}, handler });
}) as never);

const META = {
  prompt: 'a lighthouse at dusk',
  negativePrompt: 'blurry',
  sampler: 'Euler',
  steps: 8,
  cfgScale: 1,
  seed: 42,
  Model: 'krea2_turbo',
  comfy: '{"prompt":{"1":{"class_type":"UNETLoader"}}}',
};

/** Answer like civitai: nested meta on the legacy path unless flatMeta is set. */
function civitaiImages(params: Record<string, unknown>) {
  const legacy = params.imageId !== undefined || (params.modelId !== undefined && params.modelVersionId === undefined);
  const meta = legacy && params.flatMeta !== true ? { id: 7, meta: META } : META;
  return { items: [{ id: 7, width: 832, height: 1216, type: 'image', username: 'u', postId: 70, meta }] };
}

function svc() {
  const s = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }), undefined, {});
  vi.spyOn(s.rest, 'fetchEnums').mockResolvedValue({});
  vi.spyOn(s.rest, 'get').mockImplementation(async (_path: string, params = {}) => civitaiImages(params) as never);
  return s;
}

async function run(name: string, args: Record<string, unknown>) {
  const { schema, handler } = tools.get(name)!;
  return handler(z.object(schema).parse(args) as Record<string, unknown>, svc());
}

const text = (r: ToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('\n');

afterEach(() => vi.restoreAllMocks());

describe('get_image', () => {
  it('prints the generation metadata of an imageId lookup', async () => {
    const out = text(await run('get_image', { ids: [7] }));
    expect(out).toContain('Prompt: a lighthouse at dusk');
    expect(out).toContain('Negative: blurry');
    expect(out).toContain('Sampler: Euler  |  Steps: 8  |  CFG: 1  |  Seed: 42  |  Model: krea2_turbo');
  });

  it('returns the image and its metadata in structuredContent, not just errors', async () => {
    const res = await run('get_image', { ids: [7] });
    const sc = res.structuredContent as { images: Array<Record<string, unknown>>; errors: unknown[] };
    expect(sc.errors).toEqual([]);
    expect(sc.images).toHaveLength(1);
    expect(sc.images[0]).toMatchObject({
      id: 7,
      postId: 70,
      meta: { prompt: 'a lighthouse at dusk', negativePrompt: 'blurry', seed: 42, model: 'krea2_turbo' },
    });
    // The ComfyUI workflow is a blob the text leaves out too.
    expect(JSON.stringify(sc)).not.toContain('UNETLoader');
  });
});

describe('search_images', () => {
  it('shows prompts when filtering by modelId alone', async () => {
    expect(text(await run('search_images', { modelId: 5 }))).toContain('Prompt: a lighthouse at dusk');
  });
});
