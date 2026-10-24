import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { browseTools } from '../src/tools/browse.js';

/** get_model_version returned only { errors } as structuredContent: a structured client saw nothing. */
type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
browseTools(((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
  tools.set(name, { schema: config.inputSchema ?? {}, handler });
}) as never);

/** Shape of GET /api/v1/model-versions/3409322 on civitai.red (trimmed). */
const VERSION = {
  id: 3409322,
  modelId: 2761113,
  name: 'v2.0',
  status: 'Published',
  publishedAt: '2026-10-16T10:00:00.000Z',
  baseModel: 'Krea 2',
  air: 'urn:air:krea2:lora:civitai:2761113@3409322',
  trainedWords: [],
  model: { name: 'Krea 2 Identity Edit', type: 'LORA', nsfw: false, poi: false },
  files: [
    {
      name: 'krea2_general_edit_v2.safetensors',
      type: 'Model',
      primary: true,
      sizeKB: 1785435.2,
      metadata: { format: 'SafeTensor', fp: 'bf16' },
      hashes: { AutoV2: 'ABCDEF0123', SHA256: 'ABCDEF0123456789' },
    },
  ],
};

async function run(versions: Record<number, unknown>, ids: number[]) {
  const s = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }), undefined, {});
  vi.spyOn(s.rest, 'get').mockImplementation(async (path: string) => {
    const v = versions[Number(path.split('/').pop())];
    if (!v) throw new Error('Not found');
    return v as never;
  });
  const { schema, handler } = tools.get('get_model_version')!;
  return handler(z.object(schema).parse({ ids }) as Record<string, unknown>, s);
}

afterEach(() => vi.restoreAllMocks());

describe('get_model_version structuredContent', () => {
  it('carries each version, with the AIR civitai sent and the file hashes', async () => {
    const res = await run({ 3409322: VERSION }, [3409322, 999]);
    const sc = res.structuredContent as { versions: Array<Record<string, unknown>>; errors: unknown[] };
    expect(sc.versions).toEqual([
      {
        id: 3409322,
        modelId: 2761113,
        name: 'v2.0',
        modelName: 'Krea 2 Identity Edit',
        type: 'LORA',
        baseModel: 'Krea 2',
        status: 'Published',
        publishedAt: '2026-10-16T10:00:00.000Z',
        air: 'urn:air:krea2:lora:civitai:2761113@3409322',
        trainedWords: [],
        files: [
          {
            name: 'krea2_general_edit_v2.safetensors',
            type: 'Model',
            primary: true,
            sizeKB: 1785435.2,
            format: 'SafeTensor',
            hashes: { AutoV2: 'ABCDEF0123', SHA256: 'ABCDEF0123456789' },
          },
        ],
      },
    ]);
    expect(sc.errors).toEqual([{ id: 999, error: expect.stringContaining('Not found') }]);
  });

  it('builds the AIR when the response has none', async () => {
    const { air: _air, ...noAir } = VERSION;
    const res = await run({ 3409322: noAir }, [3409322]);
    const sc = res.structuredContent as { versions: Array<{ air: string | null }> };
    expect(sc.versions[0]!.air).toBe('urn:air:krea2:lora:civitai:2761113@3409322');
  });
});
