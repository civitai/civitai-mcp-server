import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { postTools } from '../src/tools/posts.js';
import { engagementTools } from '../src/tools/engagement.js';
import { collectionTools } from '../src/tools/collections.js';
import { notificationTools } from '../src/tools/notifications.js';
import { chatTools } from '../src/tools/chat.js';
import { bountyTools } from '../src/tools/bounties.js';

/**
 * Capture each tool module's handlers via a fake registrar so we can invoke a
 * single tool with parsed/defaulted args and assert on the tRPC payload it
 * shapes. No network — services.trpc.call is mocked per test.
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

/** Parse args through the tool's zod schema (applies defaults/coercion). */
function parse(schema: ZodRawShape, args: Record<string, unknown>): Record<string, unknown> {
  return z.object(schema).parse(args) as Record<string, unknown>;
}

interface Call {
  procedure: string;
  input: unknown;
  method: string;
  meta: unknown;
}

/** Stub trpc.call on a services bundle, recording calls and returning queued values. */
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

describe('create_post chaining', () => {
  it('creates -> addImage (ordered, uuid url) -> publishes with Date hint', async () => {
    const tools = collect(postTools);
    const { schema, handler } = tools.get('create_post')!;
    const svc = services();
    const calls = stubTrpc(svc, (proc) => {
      if (proc === 'post.create') return { id: 77 };
      if (proc === 'post.addImage') return { id: Math.floor(Math.random() * 1000) };
      return {};
    });

    const args = parse(schema, {
      title: 'Hi',
      images: [{ uuid: 'uuid-a', width: 100, height: 50 }, { uuid: 'uuid-b' }],
      publish: true,
    });
    const res = await handler(args, svc);
    expect(res.isError).toBeUndefined();

    const procs = calls.map((c) => c.procedure);
    expect(procs).toEqual(['post.create', 'post.addImage', 'post.addImage', 'post.update']);

    // Images carry the UUID in `url` and ordered index.
    const img0 = calls[1]!.input as Record<string, unknown>;
    const img1 = calls[2]!.input as Record<string, unknown>;
    expect(img0).toMatchObject({ postId: 77, url: 'uuid-a', index: 0, type: 'image', width: 100, height: 50 });
    expect(img1).toMatchObject({ postId: 77, url: 'uuid-b', index: 1 });

    // Publish via post.update with the Date superjson hint.
    expect(calls[3]!.procedure).toBe('post.update');
    expect((calls[3]!.input as Record<string, unknown>).id).toBe(77);
    expect(calls[3]!.meta).toEqual({ publishedAt: ['Date'] });
  });

  it('does NOT publish when publish=false', async () => {
    const tools = collect(postTools);
    const { schema, handler } = tools.get('create_post')!;
    const svc = services();
    const calls = stubTrpc(svc, (proc) => (proc === 'post.create' ? { id: 9 } : { id: 1 }));
    await handler(parse(schema, { images: [{ uuid: 'u' }] }), svc);
    expect(calls.map((c) => c.procedure)).toEqual(['post.create', 'post.addImage']);
  });

  it('deletes the orphan draft when addImage fails after create', async () => {
    const tools = collect(postTools);
    const { schema, handler } = tools.get('create_post')!;
    const svc = services();
    const calls = stubTrpc(svc, (proc) => {
      if (proc === 'post.create') return { id: 55 };
      if (proc === 'post.addImage') throw new Error('image scan rejected');
      return {};
    });
    // The handler re-throws after cleanup; the real registrar turns that into a
    // fail() result. Assert the message reports cleanup and the delete ran.
    await expect(
      handler(parse(schema, { images: [{ uuid: 'u' }], publish: true }), svc)
    ).rejects.toThrow(/Cleanup: draft post deleted/);
    // create -> addImage(fails) -> delete cleanup
    expect(calls.map((c) => c.procedure)).toEqual(['post.create', 'post.addImage', 'post.delete']);
    expect((calls[2]!.input as Record<string, unknown>).id).toBe(55);
  });
});

describe('react payload', () => {
  it('sends reaction.toggle with entityType/entityId/reaction', async () => {
    const tools = collect(engagementTools);
    const { schema, handler } = tools.get('react')!;
    const svc = services();
    const calls = stubTrpc(svc, () => undefined);
    await handler(parse(schema, { entityType: 'image', entityId: 42, reaction: 'Heart' }), svc);
    expect(calls[0]).toMatchObject({
      procedure: 'reaction.toggle',
      input: { entityType: 'image', entityId: 42, reaction: 'Heart' },
    });
  });
});

describe('upsert_resource_review payload', () => {
  it('sends rating/recommended and converts details to HTML', async () => {
    const tools = collect(engagementTools);
    const { schema, handler } = tools.get('upsert_resource_review')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 3 }));
    await handler(
      parse(schema, { modelId: 1, modelVersionId: 2, rating: 4, details: '**great**' }),
      svc
    );
    const input = calls[0]!.input as Record<string, unknown>;
    expect(input).toMatchObject({ modelId: 1, modelVersionId: 2, rating: 4, recommended: true });
    expect(String(input.details)).toContain('<strong>great</strong>');
  });
});

describe('toggle_follow_user payload', () => {
  it('resolves username -> id then calls user.toggleFollow', async () => {
    const tools = collect(engagementTools);
    const { schema, handler } = tools.get('toggle_follow_user')!;
    const svc = services();
    vi.spyOn(svc.trpc, 'lookupUser').mockResolvedValue({ id: 500, username: 'bob' });
    const calls = stubTrpc(svc, () => undefined);
    await handler(parse(schema, { user: 'bob' }), svc);
    expect(calls[0]).toMatchObject({
      procedure: 'user.toggleFollow',
      input: { targetUserId: 500, username: 'bob' },
    });
  });
});

describe('toggle_favorite_model payload', () => {
  it('passes explicit setTo', async () => {
    const tools = collect(engagementTools);
    const { schema, handler } = tools.get('toggle_favorite_model')!;
    const svc = services();
    const calls = stubTrpc(svc, () => undefined);
    await handler(parse(schema, { modelId: 7, setTo: false }), svc);
    expect(calls[0]!.input).toEqual({ modelId: 7, setTo: false });
  });
});

describe('complete_onboarding_step payload', () => {
  it('maps step name to numeric value and requires Profile fields', async () => {
    const tools = collect(engagementTools);
    const { schema, handler } = tools.get('complete_onboarding_step')!;
    const svc = services();
    const calls = stubTrpc(svc, () => undefined);
    await handler(parse(schema, { step: 'TOS' }), svc);
    expect(calls[0]!.input).toEqual({ step: 1 }); // OnboardingSteps.TOS

    // The handler throws on a Profile step missing username/email; the real
    // registrar wraps that into a fail() result, so here we just assert it throws.
    await expect(handler(parse(schema, { step: 'Profile' }), svc)).rejects.toThrow(/username and email/);
  });
});

describe('add_to_collection payload', () => {
  it('sets exactly one id field and a collections[] array', async () => {
    const tools = collect(collectionTools);
    const { schema, handler } = tools.get('add_to_collection')!;
    const svc = services();
    const calls = stubTrpc(svc, () => undefined);
    await handler(parse(schema, { itemType: 'Image', itemId: 88, collectionIds: [1, 2] }), svc);
    expect(calls[0]!.procedure).toBe('collection.saveItem');
    expect(calls[0]!.input).toEqual({
      type: 'Image',
      imageId: 88,
      collections: [{ collectionId: 1 }, { collectionId: 2 }],
    });
  });
});

describe('notifications payloads', () => {
  it('list_notifications defaults cursor to now and applies the Date hint', async () => {
    const tools = collect(notificationTools);
    const { schema, handler } = tools.get('list_notifications')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ items: [], nextCursor: null }));
    await handler(parse(schema, {}), svc);
    expect(calls[0]!.procedure).toBe('notification.getAllByUser');
    expect(calls[0]!.meta).toEqual({ cursor: ['Date'] });
    expect((calls[0]!.input as Record<string, unknown>).cursor).toBeTypeOf('string');
  });

  it('mark_notifications_read sends id as a string with the bigint hint', async () => {
    const tools = collect(notificationTools);
    const { schema, handler } = tools.get('mark_notifications_read')!;
    const svc = services();
    const calls = stubTrpc(svc, () => undefined);
    await handler(parse(schema, { id: 12345 }), svc);
    expect((calls[0]!.input as Record<string, unknown>).id).toBe('12345');
    expect(calls[0]!.meta).toEqual({ id: ['bigint'] });
  });
});

describe('chat payloads', () => {
  it('reply_to_chat sends createMessage with Markdown contentType', async () => {
    const tools = collect(chatTools);
    const { schema, handler } = tools.get('reply_to_chat')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 1 }));
    await handler(parse(schema, { chatId: 4, content: 'hello' }), svc);
    expect(calls[0]!.procedure).toBe('chat.createMessage');
    expect(calls[0]!.input).toMatchObject({ chatId: 4, content: 'hello', contentType: 'Markdown' });
  });
});

describe('bounties', () => {
  it('create_bounty uses bounty.create (not upsert) with Date hints', async () => {
    const tools = collect(bountyTools);
    const { schema, handler } = tools.get('create_bounty')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 21 }));
    await handler(
      parse(schema, {
        name: 'B',
        description: 'd',
        unitAmount: 100,
        type: 'ImageCreation',
        startsAt: '2026-07-01T00:00:00Z',
        expiresAt: '2026-07-10T00:00:00Z',
        minBenefactorUnitAmount: 10,
        images: [{ uuid: 'img-uuid' }],
      }),
      svc
    );
    expect(calls[0]!.procedure).toBe('bounty.create');
    expect(calls[0]!.meta).toEqual({ startsAt: ['Date'], expiresAt: ['Date'] });
    const input = calls[0]!.input as Record<string, unknown>;
    expect((input.images as Array<Record<string, unknown>>)[0]).toMatchObject({ url: 'img-uuid', type: 'image' });
  });

  it('award_bounty calls bountyEntry.award with { id }', async () => {
    const tools = collect(bountyTools);
    const { schema, handler } = tools.get('award_bounty')!;
    const svc = services();
    const calls = stubTrpc(svc, () => undefined);
    await handler(parse(schema, { entryId: 9 }), svc);
    expect(calls[0]).toMatchObject({ procedure: 'bountyEntry.award', input: { id: 9 } });
  });
});
