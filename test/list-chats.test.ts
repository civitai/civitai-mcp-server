import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { chatTools } from '../src/tools/chat.js';

type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

function listChats(): Handler {
  let h: Handler | undefined;
  chatTools(((name: string, _config: { inputSchema?: ZodRawShape }, handler: Handler) => {
    if (name === 'list_chats') h = handler;
  }) as never);
  return h!;
}

afterEach(() => vi.restoreAllMocks());

describe('list_chats', () => {
  // Trimmed from civitai chat.selector.ts chatMembers.select: each member drags a
  // nested user with profilePicture and cosmetics.
  const member = (userId: number, username: string, extra: Record<string, unknown> = {}) => ({
    id: userId * 10,
    userId,
    isOwner: false,
    isMuted: false,
    status: 'Joined',
    lastViewedMessageId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    user: {
      id: userId,
      username,
      deletedAt: null,
      image: null,
      profilePicture: { id: 1, url: 'x', nsfwLevel: 1, hash: 'U36t', width: 512, height: 512, metadata: { size: 1 } },
      cosmetics: [{ data: {}, cosmetic: { id: 1, name: 'frame', type: 'ProfileDecoration', data: { url: 'y' } } }],
    },
    ...extra,
  });

  it('projects members to userId, username, isOwner and status', async () => {
    const svc = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test', CIVITAI_API_KEY: 'k' }));
    vi.spyOn(svc.trpc, 'call').mockResolvedValue([
      { id: 5, chatMembers: [member(1, 'me', { isOwner: true }), member(2, 'gone', { status: 'Left' })] },
    ] as never);

    const res = await listChats()({}, svc);

    expect(res.structuredContent).toEqual({
      count: 1,
      chats: [
        {
          id: 5,
          members: [
            { userId: 1, username: 'me', isOwner: true, status: 'Joined' },
            { userId: 2, username: 'gone', isOwner: false, status: 'Left' },
          ],
        },
      ],
    });
    // A member who left is not presented as a current participant.
    expect(res.content[0]!.text).toContain('Chat #5: me, gone (Left)');
  });
});
