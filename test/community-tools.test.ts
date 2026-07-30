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
import { whoamiTools } from '../src/tools/whoami.js';
import { commentTools } from '../src/tools/comments.js';

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

/** Services with DISTINCT api/web bases, to prove user-facing links use webUrl. */
function servicesSplitUrls(): Services {
  return buildServices(
    parseConfig({
      CIVITAI_API_URL: 'http://civitai-app.internal:3000',
      CIVITAI_WEB_URL: 'https://civitai.com',
      CIVITAI_API_KEY: 'k',
    })
  );
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

describe('create_post via composite endpoint', () => {
  it('calls post.createWithImages once with sequentially-indexed images', async () => {
    const tools = collect(postTools);
    const { schema, handler } = tools.get('create_post')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({
      id: 77,
      publishedAt: '2026-06-10T00:00:00.000Z',
      imageIds: [1, 2],
      nsfwLevel: 1,
    }));

    const args = parse(schema, {
      title: 'Hi',
      images: [{ uuid: 'uuid-a', width: 100, height: 50 }, { uuid: 'uuid-b' }],
      publish: true,
    });
    const res = await handler(args, svc);
    expect(res.isError).toBeUndefined();

    // Exactly one call, to the composite endpoint.
    expect(calls.map((c) => c.procedure)).toEqual(['post.createWithImages']);
    const input = calls[0]!.input as Record<string, unknown>;
    expect(input).toMatchObject({ title: 'Hi', publish: true });

    // Images carry the UUID in `url`, sequential index, and dims.
    const imgs = input.images as Array<Record<string, unknown>>;
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toMatchObject({ url: 'uuid-a', index: 0, type: 'image', width: 100, height: 50 });
    expect(imgs[1]).toMatchObject({ url: 'uuid-b', index: 1, type: 'image' });

    // Output surfaces imageIds and the publishedAt Date string.
    expect(res.structuredContent).toMatchObject({
      id: 77,
      imageIds: [1, 2],
      published: true,
      publishedAt: '2026-06-10T00:00:00.000Z',
    });
  });

  it('passes publish=false through to the composite call', async () => {
    const tools = collect(postTools);
    const { schema, handler } = tools.get('create_post')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 9, imageIds: [5] }));
    await handler(parse(schema, { images: [{ uuid: 'u' }] }), svc);
    expect(calls.map((c) => c.procedure)).toEqual(['post.createWithImages']);
    expect((calls[0]!.input as Record<string, unknown>).publish).toBe(false);
  });

  it('forwards collectionId, tags, and modelVersionId', async () => {
    const tools = collect(postTools);
    const { schema, handler } = tools.get('create_post')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 1, imageIds: [] }));
    await handler(
      parse(schema, {
        images: [{ uuid: 'u' }],
        tags: ['anime'],
        modelVersionId: 42,
        collectionId: 7,
      }),
      svc
    );
    const input = calls[0]!.input as Record<string, unknown>;
    expect(input).toMatchObject({ tags: ['anime'], modelVersionId: 42, collectionId: 7 });
    // modelVersionId is stamped onto each image too.
    expect((input.images as Array<Record<string, unknown>>)[0]).toMatchObject({ modelVersionId: 42 });
  });
});

describe('user-facing post URLs come from webUrl, not the in-cluster apiUrl', () => {
  function textOf(res: ToolResult): string {
    return res.content.map((c) => c.text).join('\n');
  }

  it('create_post returns a public webUrl link even when apiUrl is internal', async () => {
    const tools = collect(postTools);
    const { schema, handler } = tools.get('create_post')!;
    const svc = servicesSplitUrls();
    stubTrpc(svc, () => ({ id: 77, imageIds: [1], publishedAt: '2026-06-10T00:00:00.000Z' }));
    const res = await handler(parse(schema, { images: [{ uuid: 'u' }], publish: true }), svc);

    expect(textOf(res)).toContain('https://civitai.com/posts/77');
    expect(textOf(res)).not.toContain('civitai-app.internal');
    expect(res.structuredContent).toMatchObject({ url: 'https://civitai.com/posts/77' });
  });

  it('get_post returns a public webUrl link even when apiUrl is internal', async () => {
    const tools = collect(postTools);
    const { schema, handler } = tools.get('get_post')!;
    const svc = servicesSplitUrls();
    stubTrpc(svc, () => ({ id: 29151483, title: 'T', publishedAt: '2026-06-10', user: { id: 1, username: 'a' } }));
    const res = await handler(parse(schema, { id: 29151483 }), svc);

    expect(textOf(res)).toContain('https://civitai.com/posts/29151483');
    expect(textOf(res)).not.toContain('civitai-app.internal');
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

  it('mark_chat_read marks one chat via chat.markChatRead { chatId }', async () => {
    const tools = collect(chatTools);
    const { schema, handler } = tools.get('mark_chat_read')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ chatId: 4, lastViewedMessageId: 99 }));
    const res = await handler(parse(schema, { chatId: 4 }), svc);
    expect(calls[0]!.procedure).toBe('chat.markChatRead');
    expect(calls[0]!.input).toEqual({ chatId: 4 });
    expect(res.structuredContent).toMatchObject({ chatId: 4, lastViewedMessageId: 99 });
  });

  it('mark_all_chats_read blanket-clears via chat.markAllAsRead', async () => {
    const tools = collect(chatTools);
    const { schema, handler } = tools.get('mark_all_chats_read')!;
    const svc = services();
    const calls = stubTrpc(svc, () => undefined);
    await handler(parse(schema, {}), svc);
    expect(calls[0]!.procedure).toBe('chat.markAllAsRead');
  });
});

describe('whoami uses user.getSelfStatus', () => {
  it('calls user.getSelfStatus (GET) and surfaces onboarding/muted/moderator/tier', async () => {
    const tools = collect(whoamiTools);
    const { schema, handler } = tools.get('whoami')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({
      id: 123,
      username: 'agent',
      onboarding: { raw: 15, completedSteps: ['TOS', 'Profile'], isOnboarded: true },
      muted: false,
      isModerator: true,
      bannedAt: null,
      deletedAt: null,
      tier: 'gold',
      subscriptionId: 'sub_1',
    }));
    const res = await handler(parse(schema, {}), svc);
    expect(calls[0]!.procedure).toBe('user.getSelfStatus');
    expect(calls[0]!.method).toBe('GET');
    expect(res.structuredContent).toMatchObject({
      id: 123,
      username: 'agent',
      isModerator: true,
      isOnboarded: true,
      completedSteps: ['TOS', 'Profile'],
      muted: false,
      tier: 'gold',
      subscriptionId: 'sub_1',
    });
  });
});

describe('upsert_collection payload', () => {
  it('sends name/type and only-set optional fields to collection.upsert', async () => {
    const tools = collect(collectionTools);
    const { schema, handler } = tools.get('upsert_collection')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 31 }));
    await handler(
      parse(schema, { name: 'Faves', description: 'my picks', read: 'Public' }),
      svc
    );
    expect(calls[0]!.procedure).toBe('collection.upsert');
    expect(calls[0]!.input).toEqual({
      name: 'Faves',
      type: 'Model',
      description: 'my picks',
      read: 'Public',
    });
  });

  it('includes id when updating', async () => {
    const tools = collect(collectionTools);
    const { schema, handler } = tools.get('upsert_collection')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 5 }));
    await handler(parse(schema, { id: 5, name: 'Renamed', type: 'Image' }), svc);
    expect(calls[0]!.input).toEqual({ id: 5, name: 'Renamed', type: 'Image' });
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

  it('create_bounty_entry submits via bountyEntry.submit with files + imageUuids', async () => {
    const tools = collect(bountyTools);
    const { schema, handler } = tools.get('create_bounty_entry')!;
    const svc = services();
    const calls = stubTrpc(svc, () => ({ id: 88 }));
    await handler(
      parse(schema, {
        bountyId: 12,
        description: 'my entry',
        ownRights: true,
        files: [{ url: 's3://file.zip', name: 'file.zip', sizeKB: 1024, unlockAmount: 50 }],
        images: [{ uuid: 'img-uuid' }],
      }),
      svc
    );
    expect(calls[0]!.procedure).toBe('bountyEntry.submit');
    const input = calls[0]!.input as Record<string, unknown>;
    expect(input).toMatchObject({ bountyId: 12, description: 'my entry', ownRights: true });
    expect(input.imageUuids).toEqual(['img-uuid']);
    expect((input.files as Array<Record<string, unknown>>)[0]).toMatchObject({
      url: 's3://file.zip',
      name: 'file.zip',
      sizeKB: 1024,
      unlockAmount: 50,
    });
  });

  it('create_bounty accepts USDC currency', () => {
    const tools = collect(bountyTools);
    const { schema } = tools.get('create_bounty')!;
    expect(() =>
      parse(schema, {
        name: 'B',
        description: 'd',
        unitAmount: 100,
        currency: 'USDC',
        type: 'ImageCreation',
        startsAt: '2026-07-01T00:00:00Z',
        expiresAt: '2026-07-10T00:00:00Z',
        minBenefactorUnitAmount: 10,
        images: [{ uuid: 'img-uuid' }],
      })
    ).not.toThrow();
  });
});

describe('notification categories', () => {
  it('accepts Creator and Referral categories', () => {
    const tools = collect(notificationTools);
    const { schema } = tools.get('list_notifications')!;
    expect(() => parse(schema, { category: 'Creator' })).not.toThrow();
    expect(() => parse(schema, { category: 'Referral' })).not.toThrow();

    const mark = tools.get('mark_notifications_read')!;
    expect(() => parse(mark.schema, { category: 'Referral' })).not.toThrow();
  });
});

describe('list_comments — Civitai returns json:null for empty results', () => {
  // A comment with zero replies gets `{"result":{"data":{"json":null}}}`, not an
  // empty list. list_comments recurses into replies for every top-level comment,
  // so the first childless one used to throw "Cannot read properties of null".
  it('walks a thread whose comments have no replies', async () => {
    const tools = collect(commentTools);
    const svc = services();
    stubTrpc(svc, (procedure, input) => {
      if (procedure !== 'commentv2.getInfinite') return null;
      const i = input as { entityType: string };
      if (i.entityType === 'comment') return null; // childless reply fetch
      return {
        comments: [{ id: 11, content: '<p>top level</p>', user: { id: 1, username: 'alice' } }],
        nextCursor: null,
      };
    });

    const t = tools.get('list_comments')!;
    const res = await t.handler(parse(t.schema, { entityType: 'image', entityId: 99 }), svc);

    expect(res.isError).not.toBe(true);
    expect(JSON.stringify(res)).toContain('top level');
  });

  it('reports not-found instead of throwing when get_comment returns null', async () => {
    const tools = collect(commentTools);
    const svc = services();
    stubTrpc(svc, () => null);

    const t = tools.get('get_comment')!;
    const res = await t.handler(parse(t.schema, { id: 404 }), svc);

    expect(res.isError).not.toBe(true);
    expect(JSON.stringify(res)).toContain('No comment found');
  });
});
