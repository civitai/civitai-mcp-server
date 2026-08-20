import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { articleTools, looksLikeHtmlBody } from '../src/tools/articles.js';

/**
 * Regression tests for three data-loss bugs in upsert_article. Each one silently
 * destroyed part of a live article:
 *   1. HTML content was run through the Markdown converter, which escapes every
 *      `<` — images and code blocks became visible tag soup.
 *   2. article.upsert is a full replace, but the tool sent a partial payload, so
 *      an edit nulled the cover, dropped every tag and cleared publishedAt.
 *   3. publishedAt was sent without the superjson Date hint, so it never
 *      deserialized server-side.
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
function services(): Services {
  return buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test', CIVITAI_API_KEY: 'k' }));
}
function parse(schema: ZodRawShape, args: Record<string, unknown>) {
  return z.object(schema).parse(args) as Record<string, unknown>;
}
interface Call { procedure: string; input: unknown; method: string; meta: unknown }
function stubTrpc(svc: Services, responder: (p: string, i: unknown) => unknown): Call[] {
  const calls: Call[] = [];
  vi.spyOn(svc.trpc, 'call').mockImplementation(
    async (procedure: string, input: unknown, method: 'GET' | 'POST' = 'POST', meta?: unknown) => {
      calls.push({ procedure, input, method, meta });
      return responder(procedure, input) as never;
    }
  );
  return calls;
}

/** A decorated live article: cover, 10 tags, published, an image and a code block. */
const LIVE = {
  id: 33326,
  title: 'The Azimondious Index',
  content:
    '<p>Intro.</p><p><edge-media url="36e855d8-478c-44df-80d2-d42116eed5ba" type="image" filename="i.png"></edge-media></p><p><code>steps 8</code></p>',
  status: 'Published',
  publishedAt: '2026-08-01T13:55:06.331Z',
  userNsfwLevel: 2,
  coverImage: {
    id: 138509871,
    url: '88a1f5e8-e1d6-49ac-a89a-945d59272773',
    width: 1792,
    height: 1008,
    hash: 'U36t',
    name: 'cover.jpg',
    meta: null,
    type: 'image',
  },
  tags: [{ id: 6294, name: 'original character' }, { id: 157378, name: 'index' }],
  attachments: [],
  lockedProperties: [],
};

afterEach(() => vi.restoreAllMocks());

describe('looksLikeHtmlBody', () => {
  it('detects article bodies fetched from get_article', () => {
    expect(looksLikeHtmlBody(LIVE.content)).toBe(true);
    expect(looksLikeHtmlBody('<h2 id="x">Head</h2><p>Body.</p>')).toBe(true);
    expect(looksLikeHtmlBody('<edge-media url="u" type="image"></edge-media>')).toBe(true);
  });

  it('does not fire on Markdown, including Markdown that mentions tags', () => {
    expect(looksLikeHtmlBody('## Heading\n\nSome **bold** text.')).toBe(false);
    expect(looksLikeHtmlBody('Use <edge-media> to embed an image.')).toBe(false);
    expect(looksLikeHtmlBody('')).toBe(false);
    expect(looksLikeHtmlBody('<3 this model')).toBe(false);
  });
});

describe('upsert_article content format', () => {
  it('refuses HTML in markdown mode instead of escaping it into tag soup', async () => {
    const { schema, handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 33326 }));
    await expect(
      handler(parse(schema, { id: 33326, title: 'T', content: LIVE.content }), svc)
    ).rejects.toThrow(/contentFormat: "html"/);
    expect(calls).toHaveLength(0); // nothing was sent
  });

  it('sends HTML through untouched when contentFormat=html', async () => {
    const { schema, handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    const calls = stubTrpc(svc, (p) => (p === 'article.getById' ? LIVE : { id: 33326 }));
    await handler(
      parse(schema, { id: 33326, title: 'T', content: LIVE.content, contentFormat: 'html' }),
      svc
    );
    const upsert = calls.find((c) => c.procedure === 'article.upsert')!;
    const sent = (upsert.input as Record<string, unknown>).content as string;
    expect(sent).toBe(LIVE.content);
    expect(sent).toContain('<edge-media');
    expect(sent).not.toContain('&lt;');
  });

  it('treats a missing contentFormat as markdown, even unparsed by zod', async () => {
    // A caller that bypasses schema parsing gets no zod default; the guard must
    // still fire rather than escaping the HTML into tag soup.
    const { handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 1 }));
    await expect(
      handler({ id: 33326, title: 'T', content: LIVE.content }, svc)
    ).rejects.toThrow(/contentFormat: "html"/);
    expect(calls).toHaveLength(0);
  });

  it('still converts Markdown by default', async () => {
    const { schema, handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 5 }));
    await handler(parse(schema, { title: 'T', content: '## Head\n\nHi **there**.' }), svc);
    const sent = (calls[0]!.input as Record<string, unknown>).content as string;
    expect(sent).toContain('<h2');
    expect(sent).toContain('<strong>there</strong>');
  });
});

describe('upsert_article preserves the rest of the article on update', () => {
  async function updateOnly() {
    const { schema, handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    const calls = stubTrpc(svc, (p) => (p === 'article.getById' ? LIVE : { id: 33326 }));
    await handler(
      parse(schema, { id: 33326, title: LIVE.title, content: '<p>New body.</p>', contentFormat: 'html' }),
      svc
    );
    const upsert = calls.find((c) => c.procedure === 'article.upsert')!;
    return { input: upsert.input as Record<string, unknown>, meta: upsert.meta, calls };
  }

  it('fetches the live record before writing', async () => {
    const { calls } = await updateOnly();
    const get = calls.find((c) => c.procedure === 'article.getById')!;
    expect(get.method).toBe('GET');
    expect(get.input).toEqual({ id: 33326 });
  });

  it('keeps the cover instead of nulling it', async () => {
    const { input } = await updateOnly();
    expect(input.coverImage).toMatchObject({
      id: 138509871,
      url: '88a1f5e8-e1d6-49ac-a89a-945d59272773',
      width: 1792,
    });
  });

  it('keeps the tags instead of clearing them', async () => {
    const { input } = await updateOnly();
    expect(input.tags).toEqual([
      { id: 6294, name: 'original character' },
      { id: 157378, name: 'index' },
    ]);
  });

  it('keeps status and nsfw level', async () => {
    const { input } = await updateOnly();
    expect(input.status).toBe('Published');
    expect(input.userNsfwLevel).toBe(2);
  });

  it('keeps publishedAt AND sends the superjson Date hint', async () => {
    const { input, meta } = await updateOnly();
    expect(input.publishedAt).toBe('2026-08-01T13:55:06.331Z');
    expect(meta).toEqual({ publishedAt: ['Date'] });
  });

  it('honours explicit overrides', async () => {
    const { schema, handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    const calls = stubTrpc(svc, (p) => (p === 'article.getById' ? LIVE : { id: 33326 }));
    await handler(
      parse(schema, {
        id: 33326,
        title: 'T',
        content: '<p>x</p>',
        contentFormat: 'html',
        tags: ['Fresh'],
        nsfwLevel: 'R',
      }),
      svc
    );
    const input = calls.find((c) => c.procedure === 'article.upsert')!.input as Record<string, unknown>;
    expect(input.tags).toEqual([{ name: 'fresh' }]);
    expect(input.userNsfwLevel).toBe(4);
  });

  it('lets [] explicitly clear tags', async () => {
    const { schema, handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    const calls = stubTrpc(svc, (p) => (p === 'article.getById' ? LIVE : { id: 33326 }));
    await handler(
      parse(schema, { id: 33326, title: 'T', content: '<p>x</p>', contentFormat: 'html', tags: [] }),
      svc
    );
    const input = calls.find((c) => c.procedure === 'article.upsert')!.input as Record<string, unknown>;
    expect(input.tags).toEqual([]);
  });

  it('does not fetch, and defaults to Draft, on create', async () => {
    const { schema, handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 99 }));
    await handler(parse(schema, { title: 'New', content: 'Hello.' }), svc);
    expect(calls.filter((c) => c.procedure === 'article.getById')).toHaveLength(0);
    const input = calls[0]!.input as Record<string, unknown>;
    expect(input.status).toBe('Draft');
    expect(input.publishedAt).toBeUndefined();
    expect(calls[0]!.meta).toBeUndefined();
  });

  it('fails loudly when the article does not exist', async () => {
    const { schema, handler } = collect(articleTools).get('upsert_article')!;
    const svc = services();
    stubTrpc(svc, () => null);
    await expect(
      handler(parse(schema, { id: 404, title: 'T', content: '<p>x</p>', contentFormat: 'html' }), svc)
    ).rejects.toThrow(/not found/);
  });
});
