import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { articleTools } from '../src/tools/articles.js';

/**
 * Self-contained so it never collides with other test files: this suite lives in
 * its own file rather than appended to community-tools.test.ts, which every
 * concurrent branch was also appending to.
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

function parse(schema: ZodRawShape, args: Record<string, unknown>): Record<string, unknown> {
  return z.object(schema).parse(args) as Record<string, unknown>;
}

interface Call {
  procedure: string;
  input: unknown;
  method: string;
  meta: unknown;
}

function stubTrpc(svc: Services, responder: (procedure: string, input: unknown) => unknown): Call[] {
  const calls: Call[] = [];
  vi.spyOn(svc.trpc, 'call').mockImplementation(
    async (procedure: string, input: unknown, method: 'GET' | 'POST' = 'POST', meta?: unknown) => {
      calls.push({ procedure, input, method, meta });
      return responder(procedure, input) as never;
    }
  );
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('list_articles', () => {
  const page = {
    items: [
      {
        id: 33201,
        title: 'Cosplay guide',
        publishedAt: '2026-07-29T00:00:00.000Z',
        status: 'Published',
        unlisted: false,
        tags: [{ id: 393981, name: 'beginner guide' }],
        stats: { viewCount: 109, likeCount: 7, commentCount: 4, collectedCount: 1 },
        user: { id: 3597704, username: 'Azimondious' },
      },
    ],
    nextCursor: { v: 1785140250.697, id: 33100 },
  };

  it('returns article metadata and an opaque stringified cursor', async () => {
    const tools = collect(articleTools);
    const svc = services();
    const calls = stubTrpc(svc, () => page);

    const t = tools.get('list_articles')!;
    const res = await t.handler(parse(t.schema, { username: 'Azimondious', limit: 3 }), svc);
    const sc = res.structuredContent as {
      count: number;
      nextCursor: string | null;
      articles: Array<Record<string, unknown>>;
    };

    expect(calls[0]!.procedure).toBe('article.getInfinite');
    expect(calls[0]!.input).toMatchObject({ username: 'Azimondious', limit: 3, sort: 'Newest', period: 'AllTime' });
    expect(sc.count).toBe(1);
    expect(sc.articles[0]).toMatchObject({ id: 33201, username: 'Azimondious', title: 'Cosplay guide' });
    // Cursor is handed back as a string so an agent never has to rebuild {v,id}.
    expect(sc.nextCursor).toBe(JSON.stringify(page.nextCursor));
    // Bodies must never ride along in the list.
    expect(sc.articles[0]).not.toHaveProperty('content');
  });

  it('parses the opaque cursor back into the upstream object', async () => {
    const tools = collect(articleTools);
    const svc = services();
    const calls = stubTrpc(svc, () => ({ items: [], nextCursor: null }));

    const t = tools.get('list_articles')!;
    await t.handler(parse(t.schema, { cursor: JSON.stringify(page.nextCursor) }), svc);

    expect((calls[0]!.input as { cursor?: unknown }).cursor).toEqual(page.nextCursor);
  });

  it('rejects a cursor that is not a previous nextCursor', async () => {
    const tools = collect(articleTools);
    const svc = services();
    stubTrpc(svc, () => ({ items: [] }));

    const t = tools.get('list_articles')!;
    await expect(t.handler(parse(t.schema, { cursor: 'page-2' }), svc)).rejects.toThrow(/nextCursor/);
  });
});

describe('get_article body is opt-in', () => {
  const article = {
    id: 33201,
    title: 'Cosplay guide',
    status: 'Published',
    content: '<p>' + 'x'.repeat(5000) + '</p>',
    tags: [{ name: 'guide' }],
  };

  it('omits content by default but reports its length', async () => {
    const tools = collect(articleTools);
    const svc = services();
    stubTrpc(svc, () => article);

    const t = tools.get('get_article')!;
    const res = await t.handler(parse(t.schema, { id: 33201 }), svc);
    const sc = res.structuredContent as Record<string, unknown>;

    expect(sc).not.toHaveProperty('content');
    expect(sc.contentLength).toBe(article.content.length);
    expect(sc.contentFormat).toBe('html');
  });

  it('includes content when asked', async () => {
    const tools = collect(articleTools);
    const svc = services();
    stubTrpc(svc, () => article);

    const t = tools.get('get_article')!;
    const res = await t.handler(parse(t.schema, { id: 33201, includeContent: true }), svc);
    const sc = res.structuredContent as Record<string, unknown>;

    expect(sc.content).toBe(article.content);
  });
});
