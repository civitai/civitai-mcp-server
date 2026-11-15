import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok, type Services } from './helpers.js';
import { commentToHtml } from '../lib/markdown.js';
import { stripHtml } from '../lib/format.js';

/** The entities a commentv3 section belongs to: civitai's `CommentEntityType`. */
const SECTION_TYPES = [
  'model',
  'image',
  'post',
  'article',
  'review',
  'bounty',
  'bountyEntry',
  'comicChapter',
  'challenge',
  'model3d',
  'model3dReview',
  'appListing',
  'crucible',
  'storyline',
  'postText',
] as const;

const REACTIONS = ['Like', 'Dislike', 'Laugh', 'Cry', 'Heart'] as const;
const REACTION_EMOJI: Record<string, string> = {
  Like: '👍',
  Dislike: '👎',
  Laugh: '😂',
  Cry: '😢',
  Heart: '❤️',
};

/** A commentv3 comment (`CommentV3Item`), as much of it as these tools read. */
interface CommentRow {
  id: number;
  /** A placeholder for a deleted comment that still holds live replies. */
  deleted?: boolean;
  content?: string;
  createdAt?: string | Date;
  pinnedAt?: string | Date | null;
  hidden?: boolean;
  reactionCount?: number;
  /** Count per reaction type. */
  reactions?: Record<string, number>;
  /** Direct replies, loaded or not. */
  replyCount?: number;
  /** Null on a deleted comment. */
  user?: { id?: number; username?: string | null } | null;
}

/** A commentv3 page: the comments, the top-level ids in order, and each parent's loaded replies. */
interface CommentPage {
  comments?: CommentRow[];
  rootIds?: number[];
  children?: Record<string, { ids?: number[]; nextCursor?: string | null }>;
  nextCursor?: string | null;
}

function reactionSummary(c: CommentRow): string {
  const counts = Object.entries(c.reactions ?? {}).filter(([, n]) => n > 0);
  if (counts.length === 0) return c.reactionCount ? `(${c.reactionCount} reactions)` : '';
  return (
    '(' +
    counts
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${REACTION_EMOJI[k] ?? k}${n}`)
      .join(' ') +
    ')'
  );
}

function formatComment(c: CommentRow, indent: string, cap = 280): string {
  if (c.deleted) return `${indent}#${c.id} [deleted]`;
  const author = c.user?.username ?? `user#${c.user?.id}`;
  const when = c.createdAt ? new Date(c.createdAt).toISOString().replace('T', ' ').slice(0, 16) : '';
  const pinned = c.pinnedAt ? ' [PINNED]' : '';
  const hidden = c.hidden ? ' [HIDDEN]' : '';
  const raw = stripHtml(c.content).replace(/\s+/g, ' ');
  const body = cap > 0 && raw.length > cap ? raw.slice(0, cap - 3) + '...' : raw;
  return `${indent}#${c.id} by ${author}${pinned}${hidden} at ${when} ${reactionSummary(c)}\n${indent}  ${body}`.trimEnd();
}

/** Max pages to walk per list (top-level, or one comment's replies) before giving up. */
const MAX_PAGES = 50;

/** Hard global ceiling on total comments shown per list_comments call. */
const MAX_COMMENTS_PER_CALL = 500;

type Budget = { remaining: number; truncated: boolean };

/**
 * The comments seen so far in one list_comments call. commentv3 pages are flat: a
 * section page carries top-level comments AND the replies it opened up front, tied
 * together by `rootIds` and `children`. This merges every page into one tree.
 */
class CommentTree {
  readonly byId = new Map<number, CommentRow>();
  readonly roots: number[] = [];
  /** Loaded reply ids per parent, and the cursor for the parent's next reply page (null: none). */
  readonly kids = new Map<number, { ids: number[]; nextCursor: string | null }>();

  add(page: CommentPage | null | undefined): void {
    for (const c of page?.comments ?? []) this.byId.set(c.id, c);
    for (const id of page?.rootIds ?? []) if (!this.roots.includes(id)) this.roots.push(id);
    for (const [key, entry] of Object.entries(page?.children ?? {})) {
      const parentId = Number(key);
      const known = this.kids.get(parentId) ?? { ids: [], nextCursor: null };
      for (const id of entry.ids ?? []) if (!known.ids.includes(id)) known.ids.push(id);
      known.nextCursor = entry.nextCursor ?? null;
      this.kids.set(parentId, known);
    }
  }

  /** Whether a parent has replies not loaded yet. A parent never seen is asked once. */
  hasMore(parentId: number): boolean {
    const known = this.kids.get(parentId);
    if (known) return known.nextCursor !== null;
    const parent = this.byId.get(parentId);
    return parent ? (parent.replyCount ?? 0) > 0 : true;
  }
}

/** Load every page of a section's top-level comments (`commentv3.getSection`). */
async function loadSection(
  services: Services,
  tree: CommentTree,
  entityType: string,
  entityId: number,
  sort: string,
  budget: Budget
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (tree.roots.length >= budget.remaining) {
      budget.truncated = true;
      return;
    }
    const input: Record<string, unknown> = { entityType, entityId, sort };
    if (cursor !== undefined) input.cursor = cursor;
    const res = await services.trpc.call<CommentPage | null>('commentv3.getSection', input, 'GET');
    tree.add(res);
    if (!res?.nextCursor) return;
    cursor = res.nextCursor;
  }
  budget.truncated = true;
}

/** Load the rest of one comment's replies (`commentv3.getReplies`), from where the tree stops. */
async function loadReplies(
  services: Services,
  tree: CommentTree,
  parentId: number,
  sort: string,
  budget: Budget
): Promise<void> {
  for (let page = 0; page < MAX_PAGES && tree.hasMore(parentId); page++) {
    if ((tree.kids.get(parentId)?.ids.length ?? 0) >= budget.remaining) {
      budget.truncated = true;
      return;
    }
    const input: Record<string, unknown> = { parentId, sort };
    const cursor = tree.kids.get(parentId)?.nextCursor;
    if (cursor) input.cursor = cursor;
    const res = await services.trpc.call<CommentPage | null>('commentv3.getReplies', input, 'GET');
    // A parent hidden from this viewer answers an empty page with no children entry.
    tree.add({ ...res, children: res?.children?.[parentId] ? res.children : { [parentId]: { ids: [], nextCursor: null } } });
  }
  if (tree.hasMore(parentId)) budget.truncated = true;
}

export const commentTools: ToolModule = (reg) => {
  reg(
    'list_comments',
    {
      title: 'List comments',
      description:
        'List the comments on an entity (model, image, post, article, review, bounty, etc.), or the replies to one comment (entityType=comment, entityId=the comment ID). Follows pagination so whole threads are returned, not just the first page, and nests replies up to `depth` levels. A single call shows at most 500 comments; past that the result is marked truncated. Bodies are truncated to 280 chars unless includeFull. Shows reaction counts and pin/hidden flags.',
      inputSchema: {
        entityType: z
          .enum([...SECTION_TYPES, 'comment'])
          .describe('Entity the comments are on, or `comment` to list the replies to the comment entityId'),
        entityId: z.number().int().positive().describe('Entity ID (a comment ID when entityType is comment)'),
        depth: z.number().int().min(0).max(3).default(1).describe('Reply nesting depth (0 = top-level only)'),
        sort: z.enum(['Oldest', 'Newest']).default('Oldest').describe('Sort order'),
        includeFull: z.boolean().default(false).describe('Show full bodies instead of truncating'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      const cap = args.includeFull ? 0 : 280;
      const lines: string[] = [];
      // Global ceiling shared across the whole walk, so a deep thread can't fan out unbounded.
      const budget: Budget = { remaining: MAX_COMMENTS_PER_CALL, truncated: false };
      const tree = new CommentTree();

      let top: number[];
      if (args.entityType === 'comment') {
        await loadReplies(services, tree, args.entityId, args.sort, budget);
        top = tree.kids.get(args.entityId)?.ids ?? [];
      } else {
        await loadSection(services, tree, args.entityType, args.entityId, args.sort, budget);
        top = tree.roots;
      }

      let shownTop = 0;
      const render = async (ids: number[], level: number, indent: string): Promise<void> => {
        for (const id of ids) {
          const c = tree.byId.get(id);
          if (!c) continue;
          if (budget.remaining <= 0) {
            budget.truncated = true;
            return;
          }
          budget.remaining--;
          if (level === 0) shownTop++;
          lines.push(formatComment(c, indent, cap));
          if (level >= args.depth) continue;
          // One parent's refused or failed reply fetch must not fail the whole listing:
          // show the comment, note its replies are unavailable, and keep going.
          try {
            await loadReplies(services, tree, id, args.sort, budget);
          } catch {
            lines.push(`${indent}  ↳ replies unavailable`);
          }
          const replies = (tree.kids.get(id)?.ids ?? []).filter((r) => tree.byId.has(r));
          if (replies.length) {
            lines.push(`${indent}  ↳ ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}:`);
            await render(replies, level + 1, indent + '    ');
          }
        }
      };
      await render(top, 0, '');

      const truncationNote = budget.truncated
        ? `\n\n[results truncated at ${MAX_COMMENTS_PER_CALL} comments — narrow entityId or reduce depth to see more]`
        : '';
      const footer = args.includeFull
        ? ''
        : '\n\nBodies truncated to 280 chars. Use includeFull or get_comment for full text.';
      return ok(
        (lines.join('\n\n') || 'No comments.') +
          `\n\n(${shownTop} top-level, depth=${args.depth})` +
          truncationNote +
          footer,
        { topLevelCount: shownTop, truncated: budget.truncated, maxComments: MAX_COMMENTS_PER_CALL }
      );
    }
  );

  reg(
    'get_comment',
    {
      title: 'Get comment',
      description:
        'Fetch a single comment with its full, uncapped body. commentv3 looks a comment up within the entity it is on, so pass that entity too: for a reply, the entity of the thread it is in (not the parent comment). On a model, an old comment ID from a link or notification also works.',
      inputSchema: {
        id: z.number().int().positive().describe('Comment ID'),
        entityType: z.enum(SECTION_TYPES).describe('Entity the comment is on'),
        entityId: z.number().int().positive().describe('Entity ID'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      const res = await services.trpc.call<{ comment: CommentRow }>(
        'commentv3.getThread',
        { commentId: args.id, entityType: args.entityType, entityId: args.entityId, sort: 'Oldest' },
        'GET'
      );
      const c = res.comment;
      return ok(formatComment(c, '', 0), {
        id: c.id,
        content: c.deleted ? null : stripHtml(c.content),
        entityType: args.entityType,
        entityId: args.entityId,
        replyCount: c.replyCount ?? 0,
      });
    }
  );


  reg(
    'post_comment',
    {
      title: 'Post comment or reply',
      description:
        'Post a comment on an entity, or reply to an existing comment (wraps commentv3.create). Always pass the entity the thread is on (entityType + entityId); to reply, also pass parentCommentId, and the reply goes into the parent\'s thread. Markdown is converted to the restricted comment HTML (p, br, strong, em, a). Needs an onboarded, non-muted account and the SocialWrite scope.',
      inputSchema: {
        entityType: z.enum(SECTION_TYPES).describe('Entity the comment is on (for a reply, the entity of its thread)'),
        entityId: z.number().int().positive().describe('Entity ID'),
        content: z.string().describe('Comment body in Markdown'),
        parentCommentId: z.number().int().positive().optional().describe('Reply to this comment'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = {
        entityType: args.entityType,
        entityId: args.entityId,
        content: commentToHtml(args.content),
      };
      if (args.parentCommentId !== undefined) input.parentId = args.parentCommentId;
      const res = await services.trpc.call<{ id?: number }>('commentv3.create', input);
      const isReply = args.parentCommentId !== undefined;
      return ok(`${isReply ? 'Reply' : 'Comment'} posted. ID: ${res?.id ?? '(unknown)'}`, {
        ok: true,
        id: res?.id,
        isReply,
      });
    }
  );

  reg(
    'edit_comment',
    {
      title: 'Edit comment',
      description:
        'Edit a comment you wrote, or any comment as a moderator (wraps commentv3.update). Markdown is converted to the restricted comment HTML. Needs an onboarded, non-muted account and the SocialWrite scope.',
      inputSchema: {
        id: z.number().int().positive().describe('Comment ID to edit'),
        content: z.string().describe('New body in Markdown'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('commentv3.update', { id: args.id, content: commentToHtml(args.content) });
      return ok(`Comment ${args.id} updated.`, { ok: true, id: args.id });
    }
  );

  reg(
    'delete_comment',
    {
      title: 'Delete comment',
      description:
        'Delete a comment you wrote, or any comment as a moderator (wraps commentv3.delete). A comment with replies stays as a [deleted] placeholder so its replies remain. Needs the SocialWrite scope.',
      inputSchema: { id: z.number().int().positive().describe('Comment ID to delete') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('commentv3.delete', { id: args.id });
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
      title: 'Pin comment',
      description:
        'Toggle the pinned state of a comment (wraps commentv3.togglePinned). Allowed for the owner of the entity the comment is on, and for moderators. Returns whether the comment is now pinned. Needs the SocialWrite scope.',
      inputSchema: { id: z.number().int().positive().describe('Comment ID') },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const res = await services.trpc.call<{ id?: number; pinned?: boolean }>('commentv3.togglePinned', {
        id: args.id,
      });
      const pinned = res?.pinned === true;
      return ok(`${pinned ? 'Pinned' : 'Unpinned'} comment ${args.id}.`, { ok: true, id: args.id, pinned });
    }
  );

  reg(
    'lock_thread',
    {
      title: 'Lock comment section (moderator)',
      description:
        'Toggle the lock on an entity\'s whole comment section (wraps commentv3.toggleSectionLock); a locked section takes no new comments. Moderators only. Returns whether the section is now locked.',
      inputSchema: {
        entityType: z.enum(SECTION_TYPES).describe('Entity type'),
        entityId: z.number().int().positive().describe('Entity ID'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const res = await services.trpc.call<{ locked?: boolean }>('commentv3.toggleSectionLock', {
        entityType: args.entityType,
        entityId: args.entityId,
      });
      const locked = res?.locked === true;
      return ok(
        `${locked ? 'Locked' : 'Unlocked'} the comment section on ${args.entityType}#${args.entityId}.`,
        { ok: true, entityType: args.entityType, entityId: args.entityId, locked }
      );
    }
  );
};
