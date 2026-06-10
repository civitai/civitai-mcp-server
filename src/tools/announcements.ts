import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok, type Services } from './helpers.js';
import { uploadImage } from './images.js';

interface AnnouncementRow {
  id: number;
  title: string;
  content: string;
  color?: string;
  emoji?: string;
  domain?: string[];
  startsAt?: string;
  endsAt?: string;
  disabled?: boolean;
  metadata?: {
    targetAudience?: string;
    dismissible?: boolean;
    colSpan?: number;
    image?: string;
    actions?: Array<{ type: string; link: string; linkText: string }>;
    index?: number;
  };
}

function toIso(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d.toISOString();
}

async function findAnnouncementById(services: Services, id: number): Promise<AnnouncementRow | null> {
  let page = 1;
  const limit = 50;
  for (let i = 0; i < 20; i++) {
    const res = await services.trpc.call<{ items?: AnnouncementRow[] }>(
      'announcement.getAnnouncementsPaged',
      { page, limit },
      'GET'
    );
    const items = res.items ?? [];
    const hit = items.find((x) => x.id === id);
    if (hit) return hit;
    if (items.length < limit) return null;
    page++;
  }
  return null;
}

export const announcementTools: ToolModule = (reg) => {
  reg(
    'upsert_announcement',
    {
      title: 'Create or update announcement (moderator)',
      description:
        'Create (omit id) or update (pass id) a homepage announcement banner. On update, missing fields are merged from the current row so required fields stay valid. startsAt defaults to now on create. Image can be a UUID or a URL (uploaded automatically). Moderator-only upstream.',
      inputSchema: {
        id: z.number().int().optional().describe('Existing announcement ID to update'),
        title: z.string().optional().describe('Title (required on create)'),
        content: z.string().optional().describe('Body Markdown (rendered by the server; required on create)'),
        color: z.string().optional().describe('Color token: yellow, red, blue, violet, gray, gold, green, pink...'),
        emoji: z.string().optional().describe('Optional leading emoji'),
        domains: z.array(z.enum(['all', 'red', 'green', 'blue'])).optional().describe('Domain scope (default ["all"])'),
        startsAt: z.string().optional().describe('Start time (ISO or YYYY-MM-DD); defaults to now on create'),
        endsAt: z.string().optional().describe('End time (ISO or YYYY-MM-DD)'),
        imageUuid: z.string().optional().describe('Image UUID from upload_image'),
        imageUrl: z.string().url().optional().describe('Image URL (uploaded automatically)'),
        buttons: z
          .array(z.object({ link: z.string(), text: z.string() }))
          .optional()
          .describe('Action buttons'),
        targetAudience: z.enum(['all', 'authenticated', 'unauthenticated']).optional().describe('Audience (default all)'),
        colSpan: z.number().int().optional().describe('Grid column span (default 6 = half width)'),
        dismissible: z.boolean().optional().describe('Allow dismissing (default true)'),
        disabled: z.boolean().optional().describe('Hide from the live list'),
        dryRun: z.boolean().optional().describe('Build the payload but do not send it'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const isUpdate = !!args.id;

      let existing: AnnouncementRow | null = null;
      if (isUpdate && (!args.title || !args.content)) {
        existing = await findAnnouncementById(services, args.id!);
        if (!existing) throw new Error(`Announcement ${args.id} not found`);
      }

      const title = args.title ?? existing?.title;
      if (!isUpdate && !title) throw new Error('title is required on create');
      const content = args.content ?? existing?.content;
      if (!isUpdate && !content) throw new Error('content is required on create');

      // Resolve image: explicit UUID, or upload a URL, or keep existing.
      let image = args.imageUuid ?? existing?.metadata?.image;
      if (!args.imageUuid && args.imageUrl) {
        const up = await uploadImage(services, { url: args.imageUrl });
        image = up.uuid;
      }

      const existingMeta = existing?.metadata ?? {};
      const metadata: Record<string, unknown> = {
        targetAudience: args.targetAudience ?? existingMeta.targetAudience ?? 'all',
        dismissible: args.dismissible ?? existingMeta.dismissible ?? true,
        colSpan: args.colSpan ?? existingMeta.colSpan ?? 6,
      };
      if (image) metadata.image = image;
      const actions = args.buttons?.length
        ? args.buttons.map((b) => ({ type: 'button', link: b.link, linkText: b.text }))
        : existingMeta.actions;
      if (actions?.length) metadata.actions = actions;
      if (existingMeta.index != null) metadata.index = existingMeta.index;

      const payload: Record<string, unknown> = {
        title,
        content,
        color: args.color ?? existing?.color ?? 'blue',
        domain: args.domains?.length ? args.domains : existing?.domain ?? ['all'],
        metadata,
      };
      if (args.emoji) payload.emoji = args.emoji;
      if (args.startsAt) payload.startsAt = toIso(args.startsAt);
      else if (existing?.startsAt) payload.startsAt = existing.startsAt;
      else if (!isUpdate) payload.startsAt = new Date().toISOString();
      if (args.endsAt) payload.endsAt = toIso(args.endsAt);
      else if (existing?.endsAt) payload.endsAt = existing.endsAt;
      if (args.disabled != null) payload.disabled = args.disabled;
      else if (existing?.disabled != null) payload.disabled = existing.disabled;
      if (isUpdate) payload.id = args.id;

      const metaHint: Record<string, string[]> = {};
      if (payload.startsAt) metaHint.startsAt = ['Date'];
      if (payload.endsAt) metaHint.endsAt = ['Date'];

      if (args.dryRun) {
        return ok(`DRY RUN — would ${isUpdate ? 'update' : 'create'} announcement.`, {
          ok: true,
          dryRun: true,
          input: payload,
          metaHint,
        });
      }

      const result = await services.trpc.call<{ id?: number } | number>(
        'announcement.upsertAnnouncement',
        payload,
        'POST',
        metaHint
      );
      const id = typeof result === 'number' ? result : result?.id;
      return ok(`Announcement ${isUpdate ? 'updated' : 'created'}.${id ? ` ID: ${id}` : ''}`, {
        ok: true,
        id,
        imageUuid: image,
      });
    }
  );

  reg(
    'delete_announcement',
    {
      title: 'Delete announcement (moderator)',
      description: 'Permanently delete an announcement by ID. Moderator-only upstream.',
      inputSchema: { id: z.number().int().describe('Announcement ID') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('announcement.deleteAnnouncement', { id: args.id });
      return ok(`Announcement ${args.id} deleted.`, { ok: true, id: args.id });
    }
  );

  reg(
    'list_announcements',
    {
      title: 'List announcements',
      description:
        'List announcements. scope="current" returns currently-live ones (public endpoint); scope="all" returns the paginated moderator list.',
      inputSchema: {
        scope: z.enum(['all', 'current']).default('current').describe('"current" (live) or "all" (paginated, moderator)'),
        domain: z.enum(['all', 'red', 'green', 'blue']).optional().describe('Domain filter'),
        limit: z.number().int().min(1).max(100).default(20).describe('Page size (scope=all)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      if (args.scope === 'current') {
        const input: Record<string, unknown> = {};
        if (args.domain) input.domain = args.domain;
        const result = await services.trpc.call<AnnouncementRow[]>(
          'announcement.getAnnouncements',
          input,
          'GET'
        );
        const text = result?.length
          ? result.map((a) => `${a.id}\t${a.color ?? '-'}\t${a.title}`).join('\n')
          : 'No live announcements.';
        return ok(text, { count: result?.length ?? 0, announcements: result ?? [] });
      }
      services.auth.requireKey();
      const input: Record<string, unknown> = { limit: args.limit };
      if (args.domain) input.domain = args.domain;
      const result = await services.trpc.call<{ items?: AnnouncementRow[]; totalItems?: number }>(
        'announcement.getAnnouncementsPaged',
        input,
        'GET'
      );
      const items = result.items ?? [];
      const text = items.length
        ? items
            .map((a) => `${a.id}\t${a.disabled ? '[disabled]' : '[live]'}\t${a.color ?? '-'}\t${a.title}`)
            .join('\n')
        : 'No announcements.';
      return ok(text, { count: items.length, totalItems: result.totalItems, announcements: items });
    }
  );
};
