import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { commentTools } from '../src/tools/comments.js';

/**
 * list_comments and get_comment read civitai's commentv3 router (getSection,
 * getReplies, getThread). civitai main removed the commentv2 and legacy comment
 * routers these tools used to call, so each test pins the exact procedure and
 * input sent upstream.
 */
type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
commentTools(((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
  tools.set(name, { schema: config.inputSchema ?? {}, handler });
}) as never);

async function run(name: string, svc: Services, args: Record<string, unknown>) {
  const { schema, handler } = tools.get(name)!;
  return handler(z.object(schema).parse(args) as Record<string, unknown>, svc);
}

function svc(): Services {
  return buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test', CIVITAI_API_KEY: 'k' }));
}

/** A CommentV3Item, as getSection / getReplies / getThread return it. */
function row(id: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    deleted: false,
    parentId: null,
    replyToId: null,
    depth: 0,
    content: `<p>${content}</p>`,
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    pinnedAt: null,
    hidden: false,
    tosViolation: false,
    locked: false,
    reactionCount: 0,
    user: { id: id * 10, username: `user${id}` },
    reactions: { Like: 0, Dislike: 0, Laugh: 0, Cry: 0, Heart: 0 },
    myReactions: [],
    replyCount: 0,
    ...extra,
  };
}

type Call = { procedure: string; input: Record<string, unknown>; method?: string };
type Responder = (procedure: string, input: Record<string, unknown>) => unknown;

function stub(s: Services, respond: Responder) {
  const calls: Call[] = [];
  vi.spyOn(s.trpc, 'call').mockImplementation(async (procedure: string, input: unknown, method?: string) => {
    calls.push({ procedure, input: input as Record<string, unknown>, method });
    return respond(procedure, input as Record<string, unknown>) as never;
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('list_comments on commentv3', () => {
  /**
   * Section of model 42, two pages. Page 1 opens comment 1's first reply (11) and
   * leaves more behind a cursor; comment 2 has an unopened reply. Page 2 holds 3.
   */
  const section: Responder = (procedure, input) => {
    if (procedure === 'commentv3.getSection' && input.cursor === undefined) {
      return {
        comments: [
          row(1, 'pinned note', { pinnedAt: '2026-01-05T00:00:00.000Z', replyCount: 2, reactions: { Like: 2, Heart: 1 } }),
          row(11, 'first reply', { parentId: 1, depth: 1 }),
          row(2, 'second', { replyCount: 1 }),
        ],
        rootIds: [1, 2],
        children: { 1: { ids: [11], nextCursor: 'r1' } },
        nextCursor: 'p2',
        locked: false,
      };
    }
    if (procedure === 'commentv3.getSection' && input.cursor === 'p2') {
      return { comments: [row(3, 'third')], rootIds: [3], children: {}, nextCursor: null, locked: false };
    }
    if (procedure === 'commentv3.getReplies' && input.parentId === 1) {
      return {
        comments: [row(12, 'second reply', { parentId: 1, depth: 1 })],
        rootIds: [],
        children: { 1: { ids: [12], nextCursor: null } },
        nextCursor: null,
        locked: false,
      };
    }
    if (procedure === 'commentv3.getReplies' && input.parentId === 2) {
      return {
        comments: [row(21, 'reply to second', { parentId: 2, depth: 1 })],
        rootIds: [],
        children: { 2: { ids: [21], nextCursor: null } },
        nextCursor: null,
        locked: false,
      };
    }
    throw new Error(`unexpected ${procedure} ${JSON.stringify(input)}`);
  };

  it('pages getSection by its string cursor and fills replies from getReplies', async () => {
    const s = svc();
    const calls = stub(s, section);
    const res = await run('list_comments', s, { entityType: 'model', entityId: 42 });
    expect(res.isError).not.toBe(true);
    expect(calls).toEqual([
      { procedure: 'commentv3.getSection', input: { entityType: 'model', entityId: 42, sort: 'Oldest' }, method: 'GET' },
      {
        procedure: 'commentv3.getSection',
        input: { entityType: 'model', entityId: 42, sort: 'Oldest', cursor: 'p2' },
        method: 'GET',
      },
      { procedure: 'commentv3.getReplies', input: { parentId: 1, sort: 'Oldest', cursor: 'r1' }, method: 'GET' },
      { procedure: 'commentv3.getReplies', input: { parentId: 2, sort: 'Oldest' }, method: 'GET' },
    ]);
    const text = res.content[0]!.text;
    for (const body of ['pinned note', 'first reply', 'second reply', 'second', 'reply to second', 'third']) {
      expect(text).toContain(body);
    }
    expect(text).toContain('#1 by user1 [PINNED]');
    expect(text).toContain('(❤️1 👍2)');
    expect(text).toContain('↳ 2 replies:');
    expect(text).toContain('↳ 1 reply:');
    // Replies nest under their parent, in order.
    expect(text.indexOf('first reply')).toBeLessThan(text.indexOf('second reply'));
    expect(text.indexOf('second reply')).toBeLessThan(text.indexOf('#2 by'));
    expect(res.structuredContent).toEqual({ topLevelCount: 3, truncated: false, maxComments: 500 });
  });

  it('depth 0 lists top-level only and asks for no replies', async () => {
    const s = svc();
    const calls = stub(s, section);
    const res = await run('list_comments', s, { entityType: 'model', entityId: 42, depth: 0, sort: 'Newest' });
    expect(calls.map((c) => c.procedure)).toEqual(['commentv3.getSection', 'commentv3.getSection']);
    expect(calls[0]!.input).toEqual({ entityType: 'model', entityId: 42, sort: 'Newest' });
    expect(res.content[0]!.text).not.toContain('first reply');
    expect(res.structuredContent).toMatchObject({ topLevelCount: 3 });
  });

  it('entityType=comment lists that comment\'s replies via getReplies', async () => {
    const s = svc();
    const calls = stub(s, (procedure, input) => {
      if (procedure === 'commentv3.getReplies' && input.parentId === 7) {
        return {
          comments: [row(8, 'a reply')],
          rootIds: [],
          children: { 7: { ids: [8], nextCursor: null } },
          nextCursor: null,
        };
      }
      throw new Error(`unexpected ${procedure} ${JSON.stringify(input)}`);
    });
    const res = await run('list_comments', s, { entityType: 'comment', entityId: 7 });
    expect(calls).toEqual([
      { procedure: 'commentv3.getReplies', input: { parentId: 7, sort: 'Oldest' }, method: 'GET' },
    ]);
    expect(res.content[0]!.text).toContain('a reply');
    expect(res.structuredContent).toMatchObject({ topLevelCount: 1, truncated: false });
  });

  it('an empty section is "No comments.", and a deleted placeholder shows no author', async () => {
    const s = svc();
    stub(s, () => ({ comments: [], rootIds: [], children: {}, nextCursor: null }));
    const empty = await run('list_comments', s, { entityType: 'image', entityId: 5 });
    expect(empty.content[0]!.text).toContain('No comments.');
    expect(empty.structuredContent).toMatchObject({ topLevelCount: 0, truncated: false });

    vi.restoreAllMocks();
    const s2 = svc();
    stub(s2, () => ({
      comments: [row(4, 'gone', { deleted: true, user: null, content: '' })],
      rootIds: [4],
      children: {},
      nextCursor: null,
    }));
    const res = await run('list_comments', s2, { entityType: 'image', entityId: 5, depth: 0 });
    expect(res.content[0]!.text).toContain('#4 [deleted]');
  });

  it('rejects entity types commentv3 has no section for', () => {
    const { schema } = tools.get('list_comments')!;
    expect(() => z.object(schema).parse({ entityType: 'clubPost', entityId: 1 })).toThrow();
  });
});

describe('get_comment on commentv3', () => {
  it('calls getThread with the comment and its entity', async () => {
    const s = svc();
    const long = 'x'.repeat(400);
    const calls = stub(s, () => ({
      entityType: 'post',
      entityId: 9,
      ancestorIds: [],
      comment: row(77, long, { replyCount: 3 }),
      replies: { comments: [], rootIds: [], children: {}, nextCursor: null },
      locked: false,
    }));
    const res = await run('get_comment', s, { id: 77, entityType: 'post', entityId: 9 });
    expect(calls).toEqual([
      {
        procedure: 'commentv3.getThread',
        input: { commentId: 77, entityType: 'post', entityId: 9, sort: 'Oldest' },
        method: 'GET',
      },
    ]);
    expect(res.isError).not.toBe(true);
    // Uncapped body.
    expect(res.content[0]!.text).toContain(long);
    expect(res.structuredContent).toEqual({ id: 77, content: long, entityType: 'post', entityId: 9, replyCount: 3 });
  });

  it('requires the entity', () => {
    const { schema } = tools.get('get_comment')!;
    expect(() => z.object(schema).parse({ id: 77 })).toThrow();
  });
});
