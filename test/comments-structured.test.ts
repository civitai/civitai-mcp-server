import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { commentTools } from '../src/tools/comments.js';

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

function stubTrpc(svc: Services, responder: (procedure: string, input: unknown) => unknown): void {
  vi.spyOn(svc.trpc, 'call').mockImplementation(
    async (procedure: string, input: unknown) => responder(procedure, input) as never
  );
}

afterEach(() => vi.restoreAllMocks());

describe('list_comments structuredContent', () => {
  // Clients that read structuredContent render it *instead of* the text block, so
  // returning only counts there made the tool look like it found no comments.
  it('returns the comments themselves, not just counts', async () => {
    const tools = collect(commentTools);
    const svc = services();
    stubTrpc(svc, (procedure, input) => {
      if (procedure !== 'commentv2.getInfinite') return null;
      const i = input as { entityType: string; entityId: number };
      if (i.entityType === 'article') {
        return {
          comments: [
            { id: 1, content: '<p>first</p>', user: { id: 7, username: 'alice' }, reactionCount: 2 },
            { id: 2, content: '<p>second</p>', user: { id: 8, username: 'bob' } },
          ],
          nextCursor: null,
        };
      }
      // Replies: only comment 1 has one.
      if (i.entityType === 'comment' && i.entityId === 1) {
        return { comments: [{ id: 3, content: '<p>reply</p>', user: { username: 'carol' } }], nextCursor: null };
      }
      // Upstream actually answers `json:null` for a childless comment; that path is
      // covered separately. Use an empty list here so this test isolates the
      // structured-output behaviour rather than the null guard.
      return { comments: [], nextCursor: null };
    });

    const t = tools.get('list_comments')!;
    const res = await t.handler(parse(t.schema, { entityType: 'article', entityId: 33171 }), svc);
    const sc = res.structuredContent as {
      comments: Array<{ id: number; username: string | null; content: string; depth: number; parentId: number | null }>;
      topLevelCount: number;
      totalCount: number;
    };

    expect(sc.topLevelCount).toBe(2);
    expect(sc.totalCount).toBe(3);
    expect(sc.comments.map((c) => c.content)).toEqual(['first', 'reply', 'second']);
    expect(sc.comments.map((c) => c.username)).toEqual(['alice', 'carol', 'bob']);
    // Replies carry their parent so a client can rebuild the tree.
    expect(sc.comments.find((c) => c.id === 3)).toMatchObject({ depth: 1, parentId: 1 });
    expect(sc.comments.find((c) => c.id === 1)).toMatchObject({ depth: 0, parentId: null });
  });
});

describe('list_comments structuredContent on a model discussion', () => {
  // Models are read from the legacy router (comment.getAll + getCommentsById);
  // its rows must reach structuredContent the same way commentv2 rows do.
  const legacyRow = (id: number, content: string, extra: Record<string, unknown> = {}) => ({
    id,
    content: `<p>${content}</p>`,
    user: { id: id * 10, username: `user${id}` },
    reactions: [{ reaction: 'Like' }],
    _count: { comments: 0 },
    ...extra,
  });

  it('returns the model comments and their replies with depth and parentId', async () => {
    const tools = collect(commentTools);
    const svc = services();
    stubTrpc(svc, (procedure, input) => {
      if (procedure === 'comment.getAll') {
        return {
          nextCursor: null,
          comments: [legacyRow(1, 'pinned', { pinnedAt: '2026-01-05T00:00:00.000Z', _count: { comments: 1 } }), legacyRow(2, 'plain')],
        };
      }
      if (procedure === 'comment.getCommentsById' && (input as { id: number }).id === 1) return [legacyRow(3, 'a reply')];
      return null;
    });

    const t = tools.get('list_comments')!;
    const res = await t.handler(parse(t.schema, { entityType: 'model', entityId: 42 }), svc);
    const sc = res.structuredContent as {
      comments: Array<{ id: number; content: string; depth: number; parentId: number | null; pinned: boolean; reactionCount: number }>;
      topLevelCount: number;
      totalCount: number;
      repliesUnavailable?: number[];
    };

    expect(sc.topLevelCount).toBe(2);
    expect(sc.totalCount).toBe(3);
    expect(sc.comments.map((c) => [c.id, c.depth, c.parentId])).toEqual([
      [1, 0, null],
      [3, 1, 1],
      [2, 0, null],
    ]);
    expect(sc.comments[0]).toMatchObject({ content: 'pinned', pinned: true, reactionCount: 1 });
    expect(sc.repliesUnavailable).toBeUndefined();
  });

  it('names the comments whose replies the site refused', async () => {
    const tools = collect(commentTools);
    const svc = services();
    stubTrpc(svc, (procedure) => {
      if (procedure === 'comment.getAll') {
        return { nextCursor: null, comments: [legacyRow(1, 'locked model', { _count: { comments: 2 } })] };
      }
      if (procedure === 'comment.getCommentsById') throw new Error('model is locked');
      return null;
    });

    const t = tools.get('list_comments')!;
    const res = await t.handler(parse(t.schema, { entityType: 'model', entityId: 42 }), svc);
    expect(res.structuredContent).toMatchObject({ totalCount: 1, repliesUnavailable: [1] });
  });
});
