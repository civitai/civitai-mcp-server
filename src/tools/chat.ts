import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';
import { stripHtml } from '../lib/format.js';

/**
 * Chat reading & replying (chat.*). Extends the existing send_direct_message
 * (messaging.ts), which only CREATES new chats. These let an agent read existing
 * conversations and reply into a thread.
 *
 * Verified shapes:
 *  - chat.getAllByUser: protected, UserRead. Lists the user's chats.
 *  - chat.getInfiniteMessages: protected, UserRead. { chatId, sortDirection?,
 *    limit? (default 1000), cursor? (number) }.
 *  - chat.createMessage: protected, SocialWrite. { chatId, content(1-2000),
 *    contentType? (default Markdown), referenceMessageId? }.
 *  - chat.markAllAsRead: protected, takes no input (blanket clear).
 *  - chat.markChatRead: protected. { chatId } -> { chatId, lastViewedMessageId }
 *    (mark a single conversation read).
 */

interface ChatMember {
  id?: number;
  userId?: number;
  user?: { id?: number; username?: string };
  isOwner?: boolean;
}
interface ChatRow {
  id: number;
  chatMembers?: ChatMember[];
}
interface ChatMessageRow {
  id?: number;
  userId?: number;
  content?: string;
  contentType?: string;
  createdAt?: string;
  user?: { username?: string };
}

export const chatTools: ToolModule = (reg) => {
  reg(
    'list_chats',
    {
      title: 'List my chats',
      description:
        'List the current user\'s chat conversations (chat.getAllByUser): chat id and the other participants. Use the chat ' +
        'id with get_chat_messages / reply_to_chat.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, services) => {
      services.auth.requireKey();
      const res = await services.trpc.call<ChatRow[] | { items?: ChatRow[] }>(
        'chat.getAllByUser',
        undefined,
        'GET'
      );
      const chats = Array.isArray(res) ? res : (res?.items ?? []);
      const lines = chats.map((c) => {
        const names = (c.chatMembers ?? [])
          .map((m) => m.user?.username ?? `user#${m.userId ?? m.user?.id}`)
          .join(', ');
        return `Chat #${c.id}: ${names || '(no members)'}`;
      });
      return ok((lines.join('\n') || 'No chats.') + `\n\n(${chats.length} chat(s))`, {
        count: chats.length,
        chats: chats.map((c) => ({ id: c.id, members: c.chatMembers })),
      });
    }
  );

  reg(
    'get_chat_messages',
    {
      title: 'Get chat messages',
      description:
        'Read messages in a chat (chat.getInfiniteMessages), newest-first by default. Returns messages plus a nextCursor for ' +
        'older history. Use list_chats to find the chatId.',
      inputSchema: {
        chatId: z.number().int().describe('Chat ID'),
        limit: z.number().int().min(1).max(1000).default(50).describe('Max messages to return'),
        sortDirection: z.enum(['asc', 'desc']).default('desc').describe('asc = oldest first, desc = newest first'),
        cursor: z.number().int().optional().describe('Pagination cursor from a prior nextCursor'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = {
        chatId: args.chatId,
        limit: args.limit,
        sortDirection: args.sortDirection,
      };
      if (args.cursor !== undefined) input.cursor = args.cursor;
      const res = await services.trpc.call<{
        items?: ChatMessageRow[];
        nextCursor?: number | null;
      }>('chat.getInfiniteMessages', input, 'GET');
      const items = res?.items ?? [];
      const lines = items.map((m) => {
        const who = m.user?.username ?? `user#${m.userId}`;
        const when = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '';
        return `[${when}] ${who}: ${stripHtml(m.content).replace(/\s+/g, ' ').slice(0, 500)}`;
      });
      return ok(
        (lines.join('\n') || 'No messages.') +
          (res?.nextCursor ? `\n\nOlder history available — nextCursor: ${res?.nextCursor}` : ''),
        { chatId: args.chatId, count: items.length, nextCursor: res?.nextCursor ?? null, items }
      );
    }
  );

  reg(
    'reply_to_chat',
    {
      title: 'Reply in a chat',
      description:
        'Send a message into an EXISTING chat thread (chat.createMessage). Content is sent as Markdown (server-sanitized) and ' +
        'is capped at 2000 characters. To start a NEW conversation use send_direct_message instead. Muted users can read but ' +
        'not send.',
      inputSchema: {
        chatId: z.number().int().describe('Chat ID to reply in'),
        content: z.string().min(1).max(2000).describe('Message body (Markdown, max 2000 chars)'),
        referenceMessageId: z.number().int().optional().describe('Optionally reference/quote a prior message id'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = {
        chatId: args.chatId,
        content: args.content,
        contentType: 'Markdown',
      };
      if (args.referenceMessageId) input.referenceMessageId = args.referenceMessageId;
      const res = await services.trpc.call<{ id?: number }>('chat.createMessage', input);
      return ok(`Reply sent to chat ${args.chatId} (message ${res?.id ?? '(unknown)'}).`, {
        ok: true,
        chatId: args.chatId,
        messageId: res?.id,
      });
    }
  );

  reg(
    'mark_chat_read',
    {
      title: 'Mark one chat read',
      description:
        'Mark a SINGLE chat conversation as read (chat.markChatRead) by advancing its lastViewedMessageId to the latest ' +
        'message. Use mark_all_chats_read to clear every conversation at once.',
      inputSchema: {
        chatId: z.number().int().describe('Chat ID to mark read'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const res = await services.trpc.call<{ chatId?: number; lastViewedMessageId?: number | null }>(
        'chat.markChatRead',
        { chatId: args.chatId }
      );
      return ok(`Marked chat ${args.chatId} read.`, {
        ok: true,
        chatId: res?.chatId ?? args.chatId,
        lastViewedMessageId: res?.lastViewedMessageId ?? null,
      });
    }
  );

  reg(
    'mark_all_chats_read',
    {
      title: 'Mark all chats read',
      description:
        'Mark ALL of your chats as read (chat.markAllAsRead). This is a blanket clear across every conversation. ' +
        'Use mark_chat_read to clear just one.',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async (_args, services) => {
      services.auth.requireKey();
      await services.trpc.call('chat.markAllAsRead', undefined);
      return ok('Marked all chats read.', { ok: true });
    }
  );
};
