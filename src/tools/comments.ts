import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok, type Services } from './helpers.js';
import { commentToHtml } from '../lib/markdown.js';
import { stripHtml } from '../lib/format.js';

const ENTITY_TYPES = [
  'article',
  'image',
  'post',
  'model',
  'review',
  'question',
  'answer',
  'comment',
  'bounty',
  'bountyEntry',
  'clubPost',
  'challenge',
  'comicChapter',
] as const;

const REACTIONS = ['Like', 'Dislike', 'Laugh', 'Cry', 'Heart'] as const;
const REACTION_EMOJI: Record<string, string> = {
  Like: '👍',
  Dislike: '👎',
  Laugh: '😂',
  Cry: '😢',
  Heart: '❤️',
};

interface CommentRow {
  id: number;
  content?: string;
  createdAt?: string;
  pinnedAt?: string | null;
  hidden?: boolean;
  reactionCount?: number;
  reactions?: Array<{ reaction: string }>;
  user?: { id?: number; username?: string };
}

function reactionSummary(c: CommentRow): string {
  const counts: Record<string, number> = {};
  for (const r of c.reactions ?? []) counts[r.reaction] = (counts[r.reaction] ?? 0) + 1;
  const keys = Object.keys(counts);
  if (keys.length === 0) return c.reactionCount ? `(${c.reactionCount} reactions)` : '';
  return '(' + keys.sort().map((k) => `${REACTION_EMOJI[k] ?? k}${counts[k]}`).join(' ') + ')';
}

function formatComment(c: CommentRow, indent: string, cap = 280): string {
  const author = c.user?.username ?? `user#${c.user?.id}`;
  const when = c.createdAt ? new Date(c.createdAt).toISOString().replace('T', ' ').slice(0, 16) : '';
  const pinned = c.pinnedAt ? ' [PINNED]' : '';
  const hidden = c.hidden ? ' [HIDDEN]' : '';
  const raw = stripHtml(c.content).replace(/\s+/g, ' ');
  const body = cap > 0 && raw.length > cap ? raw.slice(0, cap - 3) + '...' : raw;
  return `${indent}#${c.id} by ${author}${pinned}${hidden} at ${when} ${reactionSummary(c)}\n${indent}  ${body}`.trimEnd();
}

async function fetchComments(
  services: Services,
  entityType: string,
  entityId: number,
  limit: number,
  sort: string
): Promise<{ comments: CommentRow[]; nextCursor?: string }> {
  const res = await services.trpc.call<{ comments?: CommentRow[]; nextCursor?: string }>(
    'commentv2.getInfinite',
    { entityType, entityId, limit, sort },
    'GET'
  );
  return { comments: res.comments ?? [], nextCursor: res.nextCursor };
}

export const commentTools: ToolModule = (reg) => {
  reg(
    'list_comments',
    {
      title: 'List comments',
      description:
        'List comments on an entity (article, image, post, model, etc). Recurses into replies up to `depth` levels (replies are comments whose parent entity is comment:<parentId>). Bodies truncated to 280 chars unless includeFull. Shows aggregated reactions, pin/hidden flags.',
      inputSchema: {
        entityType: z.enum(ENTITY_TYPES).describe('Entity type the comments belong to'),
        entityId: z.number().int().describe('Entity ID'),
        depth: z.number().int().min(0).max(3).default(1).describe('Reply nesting depth (0 = top-level only)'),
        limit: z.number().int().min(1).max(100).default(20).describe('Page size'),
        sort: z.enum(['Oldest', 'Newest']).default('Oldest').describe('Sort order'),
        includeFull: z.boolean().default(false).describe('Show full bodies instead of truncating'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      const cap = args.includeFull ? 0 : 280;
      const lines: string[] = [];
      const collect = async (et: string, eid: number, d: number, indent: string): Promise<number> => {
        const { comments } = await fetchComments(services, et, eid, args.limit, args.sort);
        for (const c of comments) {
          lines.push(formatComment(c, indent, cap));
          if (d < args.depth) {
            const children = await fetchComments(services, 'comment', c.id, args.limit, args.sort);
            if (children.comments.length) {
              lines.push(`${indent}  ↳ ${children.comments.length} repl${children.comments.length === 1 ? 'y' : 'ies'}:`);
              await collect('comment', c.id, d + 1, indent + '    ');
            }
          }
        }
        return comments.length;
      };
      const top = await collect(args.entityType, args.entityId, 0, '');
      const footer = args.includeFull
        ? ''
        : '\n\nBodies truncated to 280 chars. Use includeFull or get_comment for full text.';
      return ok(
        (lines.join('\n\n') || 'No comments.') + `\n\n(${top} top-level, depth=${args.depth})` + footer,
        { topLevelCount: top }
      );
    }
  );

  reg(
    'get_comment',
    {
      title: 'Get comment',
      description: 'Fetch a single comment with its full, uncapped body.',
      inputSchema: { id: z.number().int().describe('Comment ID') },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      const c = await services.trpc.call<CommentRow>('commentv2.getSingle', { id: args.id }, 'GET');
      return ok(formatComment(c, '', 0), { id: c.id, content: stripHtml(c.content) });
    }
  );

  reg(
    'post_comment',
    {
      title: 'Post comment or reply',
      description:
        'Post a comment on an entity, or reply to an existing comment. To reply, pass parentCommentId (the reply is created as a comment on entity comment:<parentId>). Markdown is converted to the restricted comment HTML (p, br, strong, em, a).',
      inputSchema: {
        entityType: z.enum(ENTITY_TYPES).optional().describe('Entity type (omit when replying via parentCommentId)'),
        entityId: z.number().int().optional().describe('Entity ID (omit when replying via parentCommentId)'),
        content: z.string().describe('Comment body in Markdown'),
        parentCommentId: z.number().int().optional().describe('Reply to this comment (overrides entityType/entityId)'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const content = commentToHtml(args.content);
      let entityType: string;
      let entityId: number;
      if (args.parentCommentId) {
        entityType = 'comment';
        entityId = args.parentCommentId;
      } else {
        if (!args.entityType || args.entityId === undefined)
          throw new Error('Provide entityType + entityId, or parentCommentId for a reply');
        entityType = args.entityType;
        entityId = args.entityId;
      }
      const res = await services.trpc.call<{ id?: number }>('commentv2.upsert', {
        entityType,
        entityId,
        content,
      });
      return ok(
        `${args.parentCommentId ? 'Reply' : 'Comment'} posted. ID: ${res?.id ?? '(unknown)'}`,
        { ok: true, id: res?.id, isReply: !!args.parentCommentId }
      );
    }
  );

  reg(
    'edit_comment',
    {
      title: 'Edit comment',
      description:
        'Edit a comment you own. The API requires the parent entity on every upsert, so pass the comment\'s entityType + entityId (for a reply, entityType=comment and entityId=parent comment ID).',
      inputSchema: {
        id: z.number().int().describe('Comment ID to edit'),
        entityType: z.enum(ENTITY_TYPES).describe('Parent entity type'),
        entityId: z.number().int().describe('Parent entity ID'),
        content: z.string().describe('New body in Markdown'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('commentv2.upsert', {
        id: args.id,
        entityType: args.entityType,
        entityId: args.entityId,
        content: commentToHtml(args.content),
      });
      return ok(`Comment ${args.id} updated.`, { ok: true, id: args.id });
    }
  );

  reg(
    'delete_comment',
    {
      title: 'Delete comment',
      description: 'Delete a comment you own (or any comment, if moderator).',
      inputSchema: { id: z.number().int().describe('Comment ID to delete') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('commentv2.delete', { id: args.id });
      return ok(`Comment ${args.id} deleted.`, { ok: true, id: args.id });
    }
  );

  reg(
    'react_to_comment',
    {
      title: 'React to comment',
      description: 'Toggle a reaction on a comment (Like, Dislike, Laugh, Cry, Heart). Toggling the same reaction again removes it.',
      inputSchema: {
        id: z.number().int().describe('Comment ID'),
        reaction: z.enum(REACTIONS).describe('Reaction type'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('reaction.toggle', {
        entityType: 'comment',
        entityId: args.id,
        reaction: args.reaction,
      });
      return ok(`Toggled ${args.reaction} on comment ${args.id}.`, { ok: true, id: args.id, reaction: args.reaction });
    }
  );

  reg(
    'pin_comment',
    {
      title: 'Pin comment (moderator)',
      description: 'Toggle the pinned state of a comment. Moderator-gated upstream.',
      inputSchema: { id: z.number().int().describe('Comment ID') },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('commentv2.togglePinned', { id: args.id });
      return ok(`Toggled pin on comment ${args.id}.`, { ok: true, id: args.id });
    }
  );

  reg(
    'lock_thread',
    {
      title: 'Lock comment thread (moderator)',
      description: 'Toggle the lock state of an entity\'s comment thread. Moderator-gated upstream.',
      inputSchema: {
        entityType: z.enum(ENTITY_TYPES).describe('Entity type'),
        entityId: z.number().int().describe('Entity ID'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('commentv2.toggleLockThread', {
        entityType: args.entityType,
        entityId: args.entityId,
      });
      return ok(`Toggled thread lock on ${args.entityType}#${args.entityId}.`, {
        ok: true,
        entityType: args.entityType,
        entityId: args.entityId,
      });
    }
  );
};
