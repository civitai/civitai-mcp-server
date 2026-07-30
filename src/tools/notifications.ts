import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';

/**
 * Notifications (notification.* + user.checkNotifications).
 *
 * Verified gotchas:
 *  - notification.getAllByUser: protected, NotificationsRead. cursor is z.date()
 *    -> needs the ['Date'] superjson hint or it silently lands null server-side.
 *  - notification.markRead: protected, NotificationsWrite. id is z.coerce.bigint()
 *    -> JSON has no bigint, so we send it as a STRING and let coerce handle it.
 *  - user.checkNotifications: protected, quick unread count.
 */

interface NotificationRow {
  id?: number | string;
  type?: string;
  category?: string;
  read?: boolean;
  createdAt?: string;
  details?: Record<string, unknown>;
}

const CATEGORIES = [
  'Comment',
  'Update',
  'Milestone',
  'Bounty',
  'Buzz',
  'Creator',
  'Referral',
  'System',
  'Other',
] as const;

export const notificationTools: ToolModule = (reg) => {
  reg(
    'list_notifications',
    {
      title: 'List notifications',
      description:
        'List the current user\'s notifications (notification.getAllByUser). Filter to unread only and/or a category, and ' +
        'page with cursor (an ISO timestamp; the Date hint is applied automatically). Returns the items plus a nextCursor.',
      inputSchema: {
        unread: z.boolean().default(false).describe('Only return unread notifications'),
        category: z.enum(CATEGORIES).optional().describe('Filter to one notification category'),
        limit: z.number().int().min(1).max(100).default(30).describe('Page size'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor: an ISO timestamp returned as nextCursor by a prior call'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = { unread: args.unread, limit: args.limit };
      if (args.category) input.category = args.category;
      // cursor is a z.date() server-side. Default to "now" so the first page
      // works, and apply the superjson Date hint so it deserializes correctly.
      input.cursor = args.cursor ?? new Date().toISOString();
      const res = await services.trpc.call<{
        items?: NotificationRow[];
        notifications?: NotificationRow[];
        nextCursor?: string | null;
      }>('notification.getAllByUser', input, 'GET', { cursor: ['Date'] });

      const items = res?.items ?? res?.notifications ?? [];
      const lines = items.map((n) => {
        const when = n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '';
        const flag = n.read ? '' : ' [UNREAD]';
        return `#${n.id} ${n.type ?? n.category ?? 'notification'}${flag} ${when}`.trimEnd();
      });
      return ok(
        (lines.join('\n') || 'No notifications.') +
          (res?.nextCursor ? `\n\nMore available — nextCursor: ${res?.nextCursor}` : ''),
        { count: items.length, nextCursor: res?.nextCursor ?? null, items }
      );
    }
  );

  reg(
    'mark_notifications_read',
    {
      title: 'Mark notifications read',
      description:
        'Mark notifications as read (notification.markRead). Pass an id to clear one, all=true to clear everything, or a ' +
        'category to clear one bucket. The id is sent as a string because it is a bigint server-side.',
      inputSchema: {
        id: z.union([z.string(), z.number()]).optional().describe('A single notification id to mark read'),
        all: z.boolean().optional().describe('Mark ALL notifications read'),
        category: z.enum(CATEGORIES).optional().describe('Mark a whole category read'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      if (args.id === undefined && !args.all && !args.category)
        throw new Error('Provide one of: id, all=true, or category.');
      const input: Record<string, unknown> = {};
      // bigint id: send as a string and let z.coerce.bigint() handle it.
      if (args.id !== undefined) input.id = String(args.id);
      if (args.all) input.all = true;
      if (args.category) input.category = args.category;
      await services.trpc.call('notification.markRead', input, 'POST', { id: ['bigint'] });
      const what = args.all ? 'all notifications' : args.category ? `category ${args.category}` : `notification ${args.id}`;
      return ok(`Marked ${what} read.`, { ok: true, ...input });
    }
  );

  reg(
    'check_notifications',
    {
      title: 'Check unread notification count',
      description: 'Return the current user\'s unread notification count (user.checkNotifications).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, services) => {
      services.auth.requireKey();
      const res = await services.trpc.call<{ count?: number } | number>(
        'user.checkNotifications',
        undefined,
        'GET'
      );
      const count = typeof res === 'number' ? res : (res?.count ?? 0);
      return ok(`You have ${count} unread notification(s).`, { count });
    }
  );
};
