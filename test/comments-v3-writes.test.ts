import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { commentTools } from '../src/tools/comments.js';

/**
 * The comment write tools call civitai's commentv3 router. civitai main removed
 * commentv2, so each test pins the exact procedure, method and input sent
 * upstream (from src/server/routers/commentv3.router.ts and
 * src/server/schema/commentv3.schema.ts on civitai main).
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

function svc({ withKey = true } = {}): Services {
  const s = buildServices(
    parseConfig(withKey ? { CIVITAI_API_URL: 'https://x.test', CIVITAI_API_KEY: 'k' } : { CIVITAI_API_URL: 'https://x.test' })
  );
  expect(s.auth.hasKey()).toBe(withKey);
  return s;
}

type Call = { procedure: string; input: unknown; method: string };

function stub(s: Services, response: unknown) {
  const calls: Call[] = [];
  vi.spyOn(s.trpc, 'call').mockImplementation(async (procedure: string, input: unknown, method?: string) => {
    // trpc.call defaults to POST; a mutation must not be sent as a GET.
    calls.push({ procedure, input, method: method ?? 'POST' });
    return response as never;
  });
  return calls;
}

const text = (r: ToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('\n');

afterEach(() => vi.restoreAllMocks());

describe('comment write tools on commentv3', () => {
  it('post_comment creates a top-level comment with commentv3.create', async () => {
    const s = svc();
    const calls = stub(s, { id: 901, deleted: false, content: '<p>hello</p>' });
    const res = await run('post_comment', s, { entityType: 'model', entityId: 17, content: 'hello' });
    expect(calls).toEqual([
      { procedure: 'commentv3.create', input: { entityType: 'model', entityId: 17, content: '<p>hello</p>' }, method: 'POST' },
    ]);
    expect(res.structuredContent).toEqual({ ok: true, id: 901, isReply: false });
  });

  it('post_comment replies with parentId, keeping the thread entity', async () => {
    const s = svc();
    const calls = stub(s, { id: 902 });
    const res = await run('post_comment', s, {
      entityType: 'post',
      entityId: 23,
      parentCommentId: 41,
      content: 'a **reply**',
    });
    expect(calls).toEqual([
      {
        procedure: 'commentv3.create',
        input: { entityType: 'post', entityId: 23, parentId: 41, content: '<p>a <strong>reply</strong></p>' },
        method: 'POST',
      },
    ]);
    expect(res.structuredContent).toEqual({ ok: true, id: 902, isReply: true });
  });

  it('post_comment takes only commentv3 section types', () => {
    const { schema } = tools.get('post_comment')!;
    for (const bad of ['comment', 'question', 'answer', 'clubPost']) {
      expect(() => z.object(schema).parse({ entityType: bad, entityId: 1, content: 'x' })).toThrow();
    }
    expect(() => z.object(schema).parse({ entityType: 'appListing', entityId: 1, content: 'x' })).not.toThrow();
    // commentv3.create requires the entity, a reply included.
    expect(() => z.object(schema).parse({ parentCommentId: 41, content: 'x' })).toThrow();
  });

  it('edit_comment sends only id + content to commentv3.update', async () => {
    const s = svc();
    const calls = stub(s, { id: 51, content: '<p>edited</p>', updatedAt: '2026-11-14T00:00:00.000Z' });
    const res = await run('edit_comment', s, { id: 51, content: 'edited' });
    expect(calls).toEqual([{ procedure: 'commentv3.update', input: { id: 51, content: '<p>edited</p>' }, method: 'POST' }]);
    expect(res.structuredContent).toEqual({ ok: true, id: 51 });
  });

  it('delete_comment calls commentv3.delete', async () => {
    const s = svc();
    const calls = stub(s, { id: 61 });
    const res = await run('delete_comment', s, { id: 61 });
    expect(calls).toEqual([{ procedure: 'commentv3.delete', input: { id: 61 }, method: 'POST' }]);
    expect(res.structuredContent).toEqual({ ok: true, id: 61 });
  });

  it.each([
    [true, 'Pinned comment 71.'],
    [false, 'Unpinned comment 71.'],
  ])('pin_comment calls commentv3.togglePinned and reports pinned=%s', async (pinned, expected) => {
    const s = svc();
    const calls = stub(s, { id: 71, pinned });
    const res = await run('pin_comment', s, { id: 71 });
    expect(calls).toEqual([{ procedure: 'commentv3.togglePinned', input: { id: 71 }, method: 'POST' }]);
    expect(text(res)).toBe(expected);
    expect(res.structuredContent).toEqual({ ok: true, id: 71, pinned });
  });

  it.each([
    [true, 'Locked the comment section on article#83.'],
    [false, 'Unlocked the comment section on article#83.'],
  ])('lock_thread calls commentv3.toggleSectionLock and reports locked=%s', async (locked, expected) => {
    const s = svc();
    const calls = stub(s, { locked });
    const res = await run('lock_thread', s, { entityType: 'article', entityId: 83 });
    expect(calls).toEqual([
      { procedure: 'commentv3.toggleSectionLock', input: { entityType: 'article', entityId: 83 }, method: 'POST' },
    ]);
    expect(text(res)).toBe(expected);
    expect(res.structuredContent).toEqual({ ok: true, entityType: 'article', entityId: 83, locked });
  });

  it.each([
    ['post_comment', { entityType: 'model', entityId: 17, content: 'x' }],
    ['edit_comment', { id: 51, content: 'x' }],
    ['delete_comment', { id: 61 }],
    ['pin_comment', { id: 71 }],
    ['lock_thread', { entityType: 'article', entityId: 83 }],
  ])('%s refuses without a key before calling upstream', async (name, args) => {
    const s = svc({ withKey: false });
    const calls = stub(s, {});
    await expect(run(name, s, args)).rejects.toThrow('No API key available');
    expect(calls).toEqual([]);
  });
});
