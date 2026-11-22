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
    // image.get's real shape for a fresh upload: unrated (nsfwLevel 0), no block reason.
    const { imageGets } = stub(s, [], {
      7301: { id: 7301, ingestion: 'Pending', postId: 4402, nsfwLevel: 0, blockedFor: null },
    });
    const res = await run('get_image', s, { ids: [7301] });

    expect(res.isError).toBeUndefined();
    expect(imageGets).toEqual([7301]);
    expect(res.structuredContent).toEqual({
      processing: [{ id: 7301, ingestion: 'Pending', postId: 4402 }],
      blocked: [],
      failed: [],
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

  it('an image.get answer with no ingestion keeps "No image found"', async () => {
    const s = callerKey();
    stub(s, [], { 7321: { id: 7321, postId: 4404 } });
    const res = await run('get_image', s, { ids: [7321] });
    expect(res.structuredContent).toEqual({
      processing: [],
      blocked: [],
      failed: [],
      errors: [{ id: 7321, error: 'No image found with ID 7321' }],
    });
  });

  it('a Scanned image REST hid (e.g. above the browsing level) reads as existing, not missing', async () => {
    const s = callerKey();
    // nsfwLevel 16 (XXX) and a null blockedFor: neither is a block marker.
    stub(s, [], { 7322: { id: 7322, ingestion: 'Scanned', postId: 4405, nsfwLevel: 16, blockedFor: null } });
    const res = await run('get_image', s, { ids: [7322] });
    expect(res.structuredContent).toEqual({
      processing: [],
      blocked: [],
      failed: [],
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
      blocked: [],
      failed: [],
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
      blocked: [],
      failed: [],
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

const BLOCKED_TEXT = 'it is not visible to other users, and waiting will not change that.';
const APPEAL_TEXT = 'If you think this is a mistake, its page on Civitai shows whether you can appeal.';
const UNDER_REVIEW_TEXT = "it stays hidden from other users until Civitai's moderators review it.";
const GENERATION_DATA_TEXT =
  'Civitai could not verify it was AI-generated; add the generation details (prompt, tools and resources used) to its post to restore it.';
const ERROR_TEXT =
  'Civitai could not finish scanning it and retries for a while; if it is still failed later, upload the image again.';
const NOT_FOUND_TEXT = 'Civitai could not load the image file to scan it; upload the image again.';

describe('get_image reports blocked and failed images as their own state', () => {
  it('Blocked ingestion -> blocked, not "No image found"', async () => {
    const s = callerKey();
    const { imageGets } = stub(s, [], {
      7401: { id: 7401, ingestion: 'Blocked', postId: 4501, nsfwLevel: 32, blockedFor: 'tos', needsReview: null },
    });
    const res = await run('get_image', s, { ids: [7401] });

    expect(res.isError).toBeUndefined();
    expect(imageGets).toEqual([7401]);
    expect(res.structuredContent).toEqual({
      processing: [],
      blocked: [{ id: 7401, postId: 4501, remedy: null }],
      failed: [],
      errors: [],
    });
    expect(textOf(res)).toBe(`Image 7401 is blocked: ${BLOCKED_TEXT}`);
  });

  // The site's rule: any one of the three markers is a block, whatever the ingestion.
  // The remedy is what the site's image page offers the owner for that reason.
  it.each([
    ['the Blocked rating on a scanned image', { ingestion: 'Scanned', nsfwLevel: 32, blockedFor: null }, null],
    ['a ToS reason on an image being rescanned', { ingestion: 'Rescan', nsfwLevel: 4, blockedFor: 'tos' }, null],
    [
      'an unverified-AI reason on a pending image',
      { ingestion: 'Pending', nsfwLevel: 0, blockedFor: 'AiNotVerified' },
      'addGenerationData',
    ],
    ['a moderator block on a scan error', { ingestion: 'Error', nsfwLevel: 0, blockedFor: 'moderated' }, 'appeal'],
    ['a legacy capitalised moderator block', { ingestion: 'Scanned', nsfwLevel: 32, blockedFor: 'Moderated' }, 'appeal'],
    ['a CSAM reason', { ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'CSAM' }, null],
    [
      'a moderator block already under appeal',
      { ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'moderated', needsReview: 'appeal' },
      'underReview',
    ],
    [
      'a block held for another review',
      { ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'tos', needsReview: 'minor' },
      'underReview',
    ],
  ] as const)('%s -> blocked', async (_label, fields, remedy) => {
    const s = callerKey();
    stub(s, [], { 7402: { id: 7402, postId: null, ...fields } });
    const res = await run('get_image', s, { ids: [7402] });
    expect(res.structuredContent).toEqual({
      processing: [],
      blocked: [{ id: 7402, postId: null, remedy }],
      failed: [],
      errors: [],
    });
    const expected = {
      underReview: `Image 7402 is blocked: ${UNDER_REVIEW_TEXT}`,
      appeal: `Image 7402 is blocked: ${BLOCKED_TEXT} ${APPEAL_TEXT}`,
      addGenerationData: `Image 7402 is blocked: ${BLOCKED_TEXT} ${GENERATION_DATA_TEXT}`,
    };
    expect(textOf(res)).toBe(remedy ? expected[remedy] : `Image 7402 is blocked: ${BLOCKED_TEXT}`);
  });

  it('Error ingestion -> failed, with the retry advice', async () => {
    const s = callerKey();
    stub(s, [], { 7403: { id: 7403, ingestion: 'Error', postId: 4503, nsfwLevel: 0, blockedFor: null } });
    const res = await run('get_image', s, { ids: [7403] });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      processing: [],
      blocked: [],
      failed: [{ id: 7403, ingestion: 'Error', postId: 4503 }],
      errors: [],
    });
    expect(textOf(res)).toBe(`Image 7403 failed processing (ingestion: Error). ${ERROR_TEXT}`);
  });

  it('NotFound ingestion -> failed, with the upload-again advice', async () => {
    const s = callerKey();
    stub(s, [], { 7404: { id: 7404, ingestion: 'NotFound', postId: 4504, nsfwLevel: 0, blockedFor: null } });
    const res = await run('get_image', s, { ids: [7404] });
    expect(res.structuredContent).toEqual({
      processing: [],
      blocked: [],
      failed: [{ id: 7404, ingestion: 'NotFound', postId: 4504 }],
      errors: [],
    });
    expect(textOf(res)).toBe(`Image 7404 failed processing (ingestion: NotFound). ${NOT_FOUND_TEXT}`);
  });

  it('a ready image REST returns needs no image.get and reports no other state', async () => {
    const s = callerKey();
    const { imageGets } = stub(s, [7405], {});
    const res = await run('get_image', s, { ids: [7405] });
    expect(imageGets).toEqual([]);
    expect(res.structuredContent).toEqual({ processing: [], blocked: [], failed: [], errors: [] });
    expect(textOf(res)).toContain('https://img.test/7405.png');
    expect(textOf(res)).not.toContain('blocked');
    expect(textOf(res)).not.toContain('failed processing');
  });

  it('mixed batch: ready, processing, blocked and failed each land in their own section', async () => {
    const s = callerKey();
    const { imageGets } = stub(s, [7411], {
      7412: { id: 7412, ingestion: 'Pending', postId: 4511, nsfwLevel: 0, blockedFor: null },
      7413: { id: 7413, ingestion: 'Blocked', postId: 4511, nsfwLevel: 32, blockedFor: 'tos' },
      7414: { id: 7414, ingestion: 'Error', postId: 4511, nsfwLevel: 0, blockedFor: null },
    });
    const res = await run('get_image', s, { ids: [7411, 7412, 7413, 7414] });

    expect(imageGets).toEqual([7412, 7413, 7414]);
    expect(res.structuredContent).toEqual({
      processing: [{ id: 7412, ingestion: 'Pending', postId: 4511 }],
      blocked: [{ id: 7413, postId: 4511, remedy: null }],
      failed: [{ id: 7414, ingestion: 'Error', postId: 4511 }],
      errors: [],
    });
    const text = textOf(res);
    expect(text).toContain('https://img.test/7411.png');
    expect(
      text.endsWith(
        '\n\nImage 7412 is still processing (ingestion: Pending).\n' +
          'Images become visible once scanning finishes. Do not delete the post; call get_image again later.' +
          `\n\nImage 7413 is blocked: ${BLOCKED_TEXT}` +
          `\n\nImage 7414 failed processing (ingestion: Error). ${ERROR_TEXT}`
      )
    ).toBe(true);
  });

  it('a blocked image for a caller who may not see it stays "No image found"', async () => {
    const s = callerKey();
    stub(s, [], {}); // image.get answers NOT_FOUND to anyone but the owner and moderators
    const res = await run('get_image', s, { ids: [7421] });
    expect(res.structuredContent).toEqual({
      processing: [],
      blocked: [],
      failed: [],
      errors: [{ id: 7421, error: 'No image found with ID 7421' }],
    });
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
