import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { commentTools } from '../src/tools/comments.js';

/**
 * commentv2.getInfinite answers json:null when the entity has no Thread: an
 * image or post nobody has commented on, and every comment nobody has replied
 * to (the reply walk asks for comment:<id>). Null means "no comments", not an
 * error, so list_comments must not crash on either.
 */
type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
commentTools(((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
  tools.set(name, { schema: config.inputSchema ?? {}, handler });
}) as never);

async function listComments(svc: Services, args: Record<string, unknown>) {
  const { schema, handler } = tools.get('list_comments')!;
  return handler(z.object(schema).parse(args) as Record<string, unknown>, svc);
}

function svc(): Services {
  return buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test', CIVITAI_API_KEY: 'k' }));
}

function row(id: number, content: string) {
  return {
    id,
    createdAt: '2026-01-02T03:04:05.000Z',
    content: `<p>${content}</p>`,
    user: { id: id * 10, username: `user${id}` },
    reactions: [],
  };
}

type Responder = (input: Record<string, unknown>) => unknown;

function stub(s: Services, respond: Responder) {
  const calls: Array<Record<string, unknown>> = [];
  vi.spyOn(s.trpc, 'call').mockImplementation(async (procedure: string, input: unknown) => {
    expect(procedure).toBe('commentv2.getInfinite');
    calls.push(input as Record<string, unknown>);
    return respond(input as Record<string, unknown>) as never;
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('list_comments when commentv2.getInfinite returns null', () => {
  it('entity with no thread -> "No comments.", not a crash', async () => {
    const s = svc();
    stub(s, () => null);
    const res = await listComments(s, { entityType: 'image', entityId: 7 });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]!.text).toContain('No comments.');
    expect(res.structuredContent).toMatchObject({ topLevelCount: 0, truncated: false });
  });

  it('childless comments at depth 1 -> lists them, replies only where they exist', async () => {
    const s = svc();
    const calls = stub(s, (i) => {
      if (i.entityType === 'image') return { comments: [row(1, 'first'), row(2, 'second')], nextCursor: null };
      // Comment 1 has a reply; comment 2 has no thread, so the site sends null.
      if (i.entityType === 'comment' && i.entityId === 1) return { comments: [row(3, 'a reply')], nextCursor: null };
      return null;
    });
    const res = await listComments(s, { entityType: 'image', entityId: 7 });
    const text = res.content[0]!.text;
    expect(res.isError).not.toBe(true);
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text).toContain('a reply');
    expect(text).toContain('↳ 1 reply:');
    expect(res.structuredContent).toMatchObject({ topLevelCount: 2, truncated: false });
    // The null reply lookup for comment 2 was actually made.
    expect(calls).toContainEqual(expect.objectContaining({ entityType: 'comment', entityId: 2 }));
  });
});
