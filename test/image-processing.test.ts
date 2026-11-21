import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { browseTools } from '../src/tools/browse.js';
import { postTools } from '../src/tools/posts.js';
import { TrpcError } from '../src/client/trpc.js';

/**
 * A new image is hidden from REST /images until its scan finishes. get_image
 * must report the caller's own not-yet-scanned image as processing (the site's
 * image.get tells the owner it exists) instead of "No image found", and
 * create_post must say its images are processing. A client once read the
 * "not found" as failure and deleted the fresh posts.
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

const tools = new Map([...collect(browseTools), ...collect(postTools)]);

async function run(name: string, s: Services, args: Record<string, unknown>) {
  const { schema, handler } = tools.get(name)!;
  return handler(z.object(schema).parse(args) as Record<string, unknown>, s);
}

const textOf = (res: ToolResult) => res.content.map((c) => c.text).join('\n');

/** HTTP mode with the key sent on the request: the caller's own key. */
const callerKey = () => buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }), 'caller-key');

/**
 * Stub REST /images (returns the image only for ids in `onRest`) and tRPC
 * image.get (answers from `byId`; an id missing there is NOT_FOUND, as upstream).
 */
function stub(s: Services, onRest: number[], byId: Record<number, unknown>) {
  const imageGets: number[] = [];
  vi.spyOn(s.trpc, 'call').mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === 'auth.getUser') return null as never;
    if (procedure !== 'image.get') throw new Error(`unexpected ${procedure}`);
    const id = (input as { id: number }).id;
    imageGets.push(id);
    if (!(id in byId)) throw new TrpcError(`image.get: No image with id ${id}`, 404);
    return byId[id] as never;
  });
  vi.spyOn(s.rest, 'get').mockImplementation(async (_path: string, params = {}) => {
    const id = (params as { imageId: number }).imageId;
    return { items: onRest.includes(id) ? [{ id, url: `https://img.test/${id}.png`, meta: {} }] : [] } as never;
  });
  return { imageGets };
}

afterEach(() => vi.restoreAllMocks());

describe('get_image reports processing for the caller’s own unscanned image', () => {
  it('Pending image hidden from REST -> processing, not "No image found"', async () => {
    const s = callerKey();
    const { imageGets } = stub(s, [], { 7301: { id: 7301, ingestion: 'Pending', postId: 4402 } });
    const res = await run('get_image', s, { ids: [7301] });

    expect(res.isError).toBeUndefined();
    expect(imageGets).toEqual([7301]);
    expect(res.structuredContent).toEqual({
      processing: [{ id: 7301, ingestion: 'Pending', postId: 4402 }],
      errors: [],
    });
    expect(textOf(res)).toBe(
      'Image 7301 is still processing (ingestion: Pending).\n' +
        'Images become visible once scanning finishes. Do not delete the post; call get_image again later.'
    );
  });

  it.each(['Rescan', 'PendingManualAssignment'])('%s counts as processing too', async (ingestion) => {
    const s = callerKey();
    stub(s, [], { 7302: { id: 7302, ingestion, postId: null } });
    const res = await run('get_image', s, { ids: [7302] });
    expect(res.structuredContent).toMatchObject({
      processing: [{ id: 7302, ingestion, postId: null }],
      errors: [],
    });
  });

  it('mixed batch: a scanned image is returned, the unscanned one is processing', async () => {
    const s = callerKey();
    const { imageGets } = stub(s, [7311], { 7312: { id: 7312, ingestion: 'Pending', postId: 4403 } });
    const res = await run('get_image', s, { ids: [7311, 7312] });

    // image.get is only the fallback for an id REST did not return.
    expect(imageGets).toEqual([7312]);
    expect(textOf(res)).toContain('https://img.test/7311.png');
    expect(textOf(res)).toContain('Image 7312 is still processing (ingestion: Pending).');
    expect(res.structuredContent).toMatchObject({
      processing: [{ id: 7312, ingestion: 'Pending', postId: 4403 }],
      errors: [],
    });
  });

  it.each(['Error', 'Blocked', 'NotFound', undefined])(
    'ingestion %s is not reported as processing',
    async (ingestion) => {
      const s = callerKey();
      stub(s, [], { 7321: { id: 7321, ingestion, postId: 4404 } });
      const res = await run('get_image', s, { ids: [7321] });
      expect(res.structuredContent).toEqual({
        processing: [],
        errors: [{ id: 7321, error: 'No image found with ID 7321' }],
      });
    }
  );

  it('a Scanned image REST hid (e.g. above the browsing level) reads as existing, not missing', async () => {
    const s = callerKey();
    stub(s, [], { 7322: { id: 7322, ingestion: 'Scanned', postId: 4405 } });
    const res = await run('get_image', s, { ids: [7322] });
    expect(res.structuredContent).toEqual({
      processing: [],
      errors: [
        {
          id: 7322,
          error:
            'Image 7322 exists but the image search does not return it for you (for example, it is rated above your browsing level)',
        },
      ],
    });
  });

  it('a key without MediaRead (image.get 403) says the processing check could not run', async () => {
    const s = callerKey();
    vi.spyOn(s.trpc, 'call').mockImplementation(async (procedure: string) => {
      if (procedure === 'auth.getUser') return null as never;
      throw new TrpcError('image.get: Your API key does not have the required scope for this action', 403);
    });
    vi.spyOn(s.rest, 'get').mockResolvedValue({ items: [] } as never);
    const res = await run('get_image', s, { ids: [7323] });
    expect(res.structuredContent).toEqual({
      processing: [],
      errors: [
        {
          id: 7323,
          error:
            'No image found with ID 7323 (could not check whether it is still processing: your API key lacks the MediaRead scope)',
        },
      ],
    });
  });

  it('image.get NOT_FOUND (not this caller’s to see) keeps "No image found"', async () => {
    const s = callerKey();
    const { imageGets } = stub(s, [], {});
    const res = await run('get_image', s, { ids: [7331] });
    expect(imageGets).toEqual([7331]);
    expect(res.structuredContent).toEqual({
      processing: [],
      errors: [{ id: 7331, error: 'No image found with ID 7331' }],
    });
    expect(textOf(res)).not.toContain('processing (');
  });

  it('an image.get answer for a different id is ignored', async () => {
    const s = callerKey();
    stub(s, [], { 7341: { id: 9999, ingestion: 'Pending', postId: 1 } });
    const res = await run('get_image', s, { ids: [7341] });
    expect(res.structuredContent).toMatchObject({ processing: [] });
  });

  it('no API key -> no image.get call, plain not found', async () => {
    const s = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }));
    const { imageGets } = stub(s, [], { 7351: { id: 7351, ingestion: 'Pending', postId: 1 } });
    const res = await run('get_image', s, { ids: [7351] });
    expect(imageGets).toEqual([]);
    expect(res.structuredContent).toMatchObject({ processing: [], errors: [{ id: 7351 }] });
  });

  it('HTTP request on the deployment’s env key -> no image.get call', async () => {
    const s = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test', CIVITAI_API_KEY: 'env-key' }));
    expect(s.auth.keyIsCaller).toBe(false);
    const { imageGets } = stub(s, [], { 7361: { id: 7361, ingestion: 'Pending', postId: 1 } });
    const res = await run('get_image', s, { ids: [7361] });
    expect(imageGets).toEqual([]);
    expect(res.structuredContent).toMatchObject({ processing: [], errors: [{ id: 7361 }] });
  });
});

describe('create_post says its images are processing', () => {
  it('lists every attached image id as processing and tells the client not to delete', async () => {
    const s = callerKey();
    vi.spyOn(s.trpc, 'call').mockImplementation(async (procedure: string) => {
      if (procedure !== 'post.createWithImages') throw new Error(`unexpected ${procedure}`);
      return { id: 5501, imageIds: [8801, 8802], publishedAt: '2026-06-10T00:00:00.000Z' } as never;
    });
    const res = await run('create_post', s, { images: [{ uuid: 'a' }, { uuid: 'b' }], publish: true });

    expect(res.structuredContent).toMatchObject({ imageIds: [8801, 8802], processingImageIds: [8801, 8802] });
    expect(textOf(res)).toContain(
      'Images processing: 8801, 8802. Images become visible once scanning finishes. ' +
        'Do not delete the post; call get_image again later.'
    );
  });

  it('no images attached -> no processing note', async () => {
    const s = callerKey();
    vi.spyOn(s.trpc, 'call').mockResolvedValue({ id: 5502, imageIds: [] } as never);
    const res = await run('create_post', s, { images: [{ uuid: 'a' }] });
    expect(res.structuredContent).toMatchObject({ processingImageIds: [] });
    expect(textOf(res)).not.toContain('Images processing');
  });
});
