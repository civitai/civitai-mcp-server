import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { commentTools } from '../src/tools/comments.js';

/**
 * Model discussions live in the legacy comment router (comment.getAll by
 * modelId), not commentv2. A model either has no v2 Thread (getInfinite answers
 * json:null) or an empty one ({comments: []}); both must still list the
 * discussion.
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

/** A legacy row in the shape comment.getAll / getCommentsById return. */
function row(id: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: '2026-01-02T03:04:05.000Z',
    nsfw: false,
    content: `<p>${content}</p>`,
    modelId: 42,
    parentId: null,
    locked: false,
    tosViolation: false,
    hidden: false,
    pinnedAt: null,
    user: { id: id * 10, username: `user${id}`, deletedAt: null, image: null, cosmetics: [] },
    reactions: [{ id: 1, reaction: 'Like', user: { id: 1 } }],
    model: { name: 'm' },
    _count: { comments: 0 },
    ...extra,
  };
}

type Responder = (procedure: string, input: Record<string, unknown>) => unknown;

function stub(s: Services, respond: Responder) {
  const calls: Array<{ procedure: string; input: Record<string, unknown> }> = [];
  vi.spyOn(s.trpc, 'call').mockImplementation(async (procedure: string, input: unknown) => {
    calls.push({ procedure, input: input as Record<string, unknown> });
    return respond(procedure, input as Record<string, unknown>) as never;
  });
  return calls;
}

/** The legacy discussion of model 42: a pinned comment with one reply, then a plain one. */
const legacy: Responder = (procedure, input) => {
  if (procedure === 'comment.getAll') {
    return {
      nextCursor: null,
      comments: [
        row(1, 'pinned note', { pinnedAt: '2026-01-05T00:00:00.000Z', _count: { comments: 1 } }),
        row(2, 'plain comment'),
      ],
    };
  }
  if (procedure === 'comment.getCommentsById' && input.id === 1) {
    return [row(3, 'a reply', { parentId: 1 })];
  }
  return null;
};

afterEach(() => vi.restoreAllMocks());

describe('list_comments on a model reads the legacy discussion', () => {
  it.each([
    ['no v2 Thread (getInfinite json:null)', null],
    ['empty v2 Thread (getInfinite {comments: []})', { comments: [], nextCursor: null }],
  ])('%s -> lists the model comments and replies', async (_label, v2) => {
    const s = svc();
    const calls = stub(s, (p, i) => (p === 'commentv2.getInfinite' ? v2 : legacy(p, i)));
    const res = await listComments(s, { entityType: 'model', entityId: 42 });
    const text = res.content[0]!.text;
    expect(res.isError).not.toBe(true);
    expect(text).toContain('pinned note');
    expect(text).toContain('plain comment');
    expect(text).toContain('a reply');
    expect(text).not.toContain('No comments.');
    expect(res.structuredContent).toMatchObject({ topLevelCount: 2 });
    expect(calls.some((c) => c.procedure.startsWith('commentv2.'))).toBe(false);
  });

  it('keeps the server order, pinned first', async () => {
    const s = svc();
    stub(s, legacy);
    const text = (await listComments(s, { entityType: 'model', entityId: 42 })).content[0]!.text;
    expect(text.indexOf('pinned note')).toBeLessThan(text.indexOf('plain comment'));
    expect(text).toContain('[PINNED]');
  });

  it('sends modelId, the lowercase legacy sort and the page size', async () => {
    const s = svc();
    const calls = stub(s, legacy);
    await listComments(s, { entityType: 'model', entityId: 42, sort: 'Newest', limit: 5 });
    expect(calls[0]).toEqual({
      procedure: 'comment.getAll',
      input: { modelId: 42, limit: 5, sort: 'newest' },
    });
  });

  it('pages with the numeric nextCursor', async () => {
    const s = svc();
    const calls = stub(s, (p, i) => {
      if (p !== 'comment.getAll') return null;
      return i.cursor === 7
        ? { nextCursor: null, comments: [row(8, 'second page')] }
        : { nextCursor: 7, comments: [row(6, 'first page')] };
    });
    const text = (await listComments(s, { entityType: 'model', entityId: 42 })).content[0]!.text;
    expect(text).toContain('first page');
    expect(text).toContain('second page');
    expect(calls.filter((c) => c.procedure === 'comment.getAll').map((c) => c.input.cursor)).toEqual([
      undefined,
      7,
    ]);
  });

  it('fetches replies only for comments that have them, and not at depth 0', async () => {
    const s = svc();
    const calls = stub(s, legacy);
    await listComments(s, { entityType: 'model', entityId: 42 });
    expect(calls.filter((c) => c.procedure === 'comment.getCommentsById').map((c) => c.input)).toEqual([
      { id: 1 },
    ]);

    const s0 = svc();
    const calls0 = stub(s0, legacy);
    const text0 = (await listComments(s0, { entityType: 'model', entityId: 42, depth: 0 })).content[0]!.text;
    expect(calls0.some((c) => c.procedure === 'comment.getCommentsById')).toBe(false);
    expect(text0).not.toContain('a reply');
  });

  it('leaves out ToS-violation replies and marks hidden ones', async () => {
    const s = svc();
    stub(s, (p, i) => {
      if (p === 'comment.getAll') return { nextCursor: null, comments: [row(1, 'parent', { _count: { comments: 2 } })] };
      if (p === 'comment.getCommentsById' && i.id === 1) {
        return [row(4, 'removed reply', { parentId: 1, tosViolation: true }), row(5, 'hidden reply', { parentId: 1, hidden: true })];
      }
      return null;
    });
    const text = (await listComments(s, { entityType: 'model', entityId: 42 })).content[0]!.text;
    expect(text).not.toContain('removed reply');
    expect(text).toContain('hidden reply');
    expect(text).toMatch(/#5 by user5 \[HIDDEN\]/);
  });

  it('null from comment.getAll or getCommentsById reads as no comments, never a crash', async () => {
    const s = svc();
    stub(s, () => null);
    const res = await listComments(s, { entityType: 'model', entityId: 42 });
    expect(res.content[0]!.text).toContain('No comments.');

    const s2 = svc();
    stub(s2, (p) =>
      p === 'comment.getAll' ? { nextCursor: null, comments: [row(1, 'parent', { _count: { comments: 1 } })] } : null
    );
    expect((await listComments(s2, { entityType: 'model', entityId: 42 })).content[0]!.text).toContain('parent');
  });
});

describe('model discussion edge cases', () => {
  it('a refused reply fetch does not fail the listing', async () => {
    const s = svc();
    stub(s, (p) => {
      if (p === 'comment.getAll') {
        return { nextCursor: null, comments: [row(1, 'first', { _count: { comments: 1 } }), row(2, 'second')] };
      }
      if (p === 'comment.getCommentsById') throw new Error('comment.getCommentsById: No comment with id 1');
      return null;
    });
    const res = await listComments(s, { entityType: 'model', entityId: 42 });
    const text = res.content[0]!.text;
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text).toContain('replies unavailable');
  });

  it('a row repeated on the next page is listed once', async () => {
    const s = svc();
    stub(s, (p, i) => {
      if (p !== 'comment.getAll') return null;
      return i.cursor === 7
        ? { nextCursor: null, comments: [row(6, 'repeated'), row(8, 'new')] }
        : { nextCursor: 7, comments: [row(6, 'repeated')] };
    });
    const res = await listComments(s, { entityType: 'model', entityId: 42 });
    expect(res.content[0]!.text.match(/repeated/g)).toHaveLength(1);
    expect(res.structuredContent).toMatchObject({ topLevelCount: 2 });
  });

  it('stops at the 500-comment ceiling and reports truncation, including skipped replies', async () => {
    const s = svc();
    const calls = stub(s, (p, i) => {
      if (p !== 'comment.getAll') return null;
      // 120 per page: the site prepends pinned rows, so a page can exceed `limit`.
      const start = (i.cursor as number | undefined) ?? 0;
      const comments = Array.from({ length: 120 }, (_, k) => row(start + k + 1, `c${start + k + 1}`, { _count: { comments: 1 } }));
      return { nextCursor: start + 120, comments };
    });
    const res = await listComments(s, { entityType: 'model', entityId: 42, limit: 100, depth: 0 });
    expect(res.structuredContent).toMatchObject({ topLevelCount: 500, truncated: true });
    expect(calls.filter((c) => c.procedure === 'comment.getAll')).toHaveLength(5);

    const s2 = svc();
    stub(s2, (p) =>
      p === 'comment.getAll'
        ? { nextCursor: null, comments: Array.from({ length: 500 }, (_, k) => row(k + 1, `c${k + 1}`, { _count: { comments: 1 } })) }
        : [row(9999, 'reply', { parentId: 1 })]
    );
    const res2 = await listComments(s2, { entityType: 'model', entityId: 42, limit: 100 });
    expect(res2.structuredContent).toMatchObject({ topLevelCount: 500, truncated: true });
  });

  it('the footer does not point model readers at get_comment', async () => {
    const s = svc();
    stub(s, legacy);
    const text = (await listComments(s, { entityType: 'model', entityId: 42 })).content[0]!.text;
    expect(text).not.toContain('get_comment');
  });
});

describe('other entity types still use commentv2', () => {
  it('image -> commentv2.getInfinite, never comment.getAll', async () => {
    const s = svc();
    const calls = stub(s, (p, i) =>
      p === 'commentv2.getInfinite' && i.entityType === 'image'
        ? { comments: [{ id: 11, content: '<p>image comment</p>', user: { id: 1, username: 'alice' } }], nextCursor: null }
        : { comments: [], nextCursor: null }
    );
    const text = (await listComments(s, { entityType: 'image', entityId: 9 })).content[0]!.text;
    expect(text).toContain('image comment');
    expect(calls.some((c) => c.procedure.startsWith('comment.'))).toBe(false);
    expect(calls[0]).toMatchObject({ procedure: 'commentv2.getInfinite', input: { entityType: 'image', entityId: 9 } });
  });
});
