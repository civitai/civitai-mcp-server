import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { displayDate, ok } from './helpers.js';
import { mdToHtml } from '../lib/markdown.js';
import { uploadImage } from './images.js';

const NSFW_MAP: Record<string, number> = { PG: 1, PG13: 2, R: 4, X: 8, XXX: 16, Blocked: 32 };

/**
 * True when `content` is an HTML document body rather than Markdown.
 *
 * mdToHtml escapes every `<`, so an HTML body passed through it renders as
 * visible tag soup and every <edge-media> image and code block is destroyed.
 * This is a heuristic guard, not a parser: it only has to catch bodies fetched
 * from get_article, which always arrive as tag-dense single-line HTML.
 */
export function looksLikeHtmlBody(content: string): boolean {
  const s = content.trim();
  if (!s.startsWith('<')) return false;
  // A block-level open tag at the start, plus any closing tag later on.
  if (!/^<(p|div|h[1-6]|ul|ol|blockquote|pre|hr|edge-media|figure|table|section)\b[^>]*>/i.test(s)) {
    return false;
  }
  return /<\/(p|div|h[1-6]|ul|ol|li|blockquote|pre|strong|em|a)>/i.test(s) || /<edge-media\b/i.test(s);
}

interface ArticleRow {
  id: number;
  title: string;
  content: string;
  status?: string;
  publishedAt?: string | Date;
  userNsfwLevel?: number;
  coverImage?: {
    id?: number;
    url: string;
    width?: number;
    height?: number;
    hash?: string | null;
    name?: string;
    meta?: unknown;
    type?: string;
  } | null;
  /** isCategory is derived by getById (the tag is linked from the article category system tag). */
  tags?: Array<{ id?: number; name: string; isCategory?: boolean }>;
}

export const articleTools: ToolModule = (reg) => {
  reg(
    'upsert_article',
    {
      title: 'Create or update article',
      description:
        'Create (omit id) or update (pass id) a Civitai article. ' +
        'CONTENT FORMAT: contentFormat="markdown" (default) converts Markdown to HTML; ' +
        'contentFormat="html" sends your HTML through untouched, which is the only way to write ' +
        '<edge-media> images, and is required when round-tripping a body fetched from get_article. ' +
        'UPDATES KEEP WHAT YOU DO NOT PASS: article.upsert deletes the cover and resets the rating to PG when ' +
        'they are omitted, so when id is passed this tool first fetches the article and re-sends its cover and ' +
        'rating. Status and tags are left as they are unless you pass them; a tags list replaces the tags but ' +
        'keeps the article\'s category. ' +
        'Optionally attach a cover by UUID (coverImageUuid) or by URL (coverImageUrl, uploaded automatically).',
      inputSchema: {
        title: z.string().describe('Article title'),
        content: z.string().describe('Article body (Markdown by default; raw HTML if contentFormat="html")'),
        contentFormat: z
          .enum(['markdown', 'html'])
          .default('markdown')
          .describe('How to treat `content`. Use "html" to preserve <edge-media>, code blocks and spans.'),
        id: z.number().int().optional().describe('Existing article ID to update'),
        status: z
          .enum(['Draft', 'Published'])
          .optional()
          .describe('Draft or Published. On update, omit to keep the current status. Defaults to Draft on create.'),
        nsfwLevel: z
          .enum(['PG', 'PG13', 'R', 'X', 'XXX', 'Blocked'])
          .optional()
          .describe('Content rating (userNsfwLevel). On update, omit to keep the current rating.'),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            'Tag names (lowercased). On update, omit to keep the current tags; a list replaces them ([] clears ' +
              'them), except the category tag, which is kept.'
          ),
        coverImageUuid: z.string().optional().describe('Cover image UUID from upload_image'),
        coverImageUrl: z.string().url().optional().describe('Cover image URL (uploaded automatically)'),
        coverWidth: z.number().int().optional().describe('Cover width (when using a UUID)'),
        coverHeight: z.number().int().optional().describe('Cover height (when using a UUID)'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();

      // Markdown mode escapes every `<`, so HTML handed to it silently turns into
      // visible tag soup and images/code blocks are destroyed. Refuse instead.
      // Anything other than an explicit "html" is markdown: relying on the zod
      // default would let a caller that skips schema parsing slip past the guard.
      const asHtml = args.contentFormat === 'html';
      if (!asHtml && looksLikeHtmlBody(args.content)) {
        throw new Error(
          'content looks like HTML but contentFormat is "markdown", which would escape every tag ' +
            'and render the body as visible tag soup (destroying <edge-media> images and code blocks). ' +
            'Pass contentFormat: "html" to send it through untouched, or supply real Markdown.'
        );
      }

      const html = asHtml ? args.content : mdToHtml(args.content);
      if (!html || html === '<p></p>') throw new Error('Converted HTML content is empty');

      // article.upsert keeps whatever is omitted EXCEPT the cover (an omitted
      // coverImage deletes the old cover image) and userNsfwLevel (defaults to PG).
      // So on update, read the live record and re-send exactly those two.
      let current: ArticleRow | null = null;
      if (args.id) {
        current = await services.trpc.call<ArticleRow | null>('article.getById', { id: args.id }, 'GET');
        if (!current) {
          throw new Error(`Article ${args.id} not found (or not visible to your account)`);
        }
      }

      let coverUuid = args.coverImageUuid;
      let coverW = args.coverWidth;
      let coverH = args.coverHeight;
      if (!coverUuid && args.coverImageUrl) {
        const up = await uploadImage(services, { url: args.coverImageUrl });
        coverUuid = up.uuid;
        coverW = coverW ?? up.width;
        coverH = coverH ?? up.height;
      }

      const input: Record<string, unknown> = { title: args.title, content: html };
      if (args.id) input.id = args.id;

      if (coverUuid) {
        input.coverImage = {
          url: coverUuid,
          width: coverW ?? 1024,
          height: coverH ?? 576,
          hash: null,
          name: 'cover.png',
          meta: null,
          type: 'image',
        };
      } else if (current?.coverImage) {
        input.coverImage = {
          id: current.coverImage.id,
          url: current.coverImage.url,
          width: current.coverImage.width,
          height: current.coverImage.height,
          hash: current.coverImage.hash ?? null,
          name: current.coverImage.name ?? 'cover',
          meta: current.coverImage.meta ?? null,
          type: current.coverImage.type ?? 'image',
        };
      }

      // A stored 0 means "never set"; the schema has no level 0 and rejects the whole save.
      input.userNsfwLevel =
        args.nsfwLevel !== undefined ? (NSFW_MAP[args.nsfwLevel] ?? 1) : current?.userNsfwLevel || 1;

      // Omitted status is left alone. Re-sending a stored "Published" would run the
      // publish-time image scan check and refuse edits the site itself allows.
      const status = args.status ?? (args.id ? undefined : 'Draft');
      if (status) input.status = status;

      if (args.tags !== undefined) {
        const names = args.tags.map((name) => name.toLowerCase());
        // A tags list replaces the whole set, and the category is just one of those
        // tags: dropping it silently de-categorises the article, so keep it.
        const category = (current?.tags ?? []).filter((t) => t.isCategory && !names.includes(t.name));
        input.tags = [...category.map((t) => ({ id: t.id, name: t.name })), ...names.map((name) => ({ name }))];
      }

      const result = await services.trpc.call<{ id?: number } | number>('article.upsert', input);
      const id = typeof result === 'number' ? result : result?.id;
      const statusNote = status ? `as ${status}` : `(status unchanged: ${current?.status ?? 'unknown'})`;
      return ok(
        `Article ${args.id ? 'updated' : 'created'} ${statusNote}` +
          ` (content sent as ${asHtml ? 'html' : 'markdown'}).` +
          (args.id
            ? `\nKept: cover and rating unless overridden; tags ${args.tags ? 'replaced, category kept' : 'untouched'}.`
            : '') +
          (id ? `\nID: ${id}\nView: ${services.config.webUrl}/articles/${id}` : ''),
        {
          ok: true,
          id,
          status: status ?? current?.status ?? null,
          contentFormat: asHtml ? 'html' : 'markdown',
          coverImageUuid: coverUuid,
        }
      );
    }
  );

  reg(
    'publish_article',
    {
      title: 'Publish article',
      description:
        'Publish a draft article. Fetches the current article, rebuilds the full upsert payload (so nothing regresses), and sets status=Published + publishedAt=now with the superjson Date hint required for the date to deserialize server-side. Idempotent: a no-op on already-published articles.',
      inputSchema: {
        id: z.number().int().describe('Article ID to publish'),
        dryRun: z.boolean().optional().describe('Build the payload but do not send it'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const current = await services.trpc.call<ArticleRow | null>(
        'article.getById',
        { id: args.id },
        'GET'
      );
      if (!current) throw new Error(`Article ${args.id} not found (or not visible to your account)`);
      if (current.status === 'Published') {
        return ok(`Article ${args.id} is already Published (publishedAt=${displayDate(current.publishedAt)}).`, {
          ok: true,
          id: args.id,
          status: 'Published',
          alreadyPublished: true,
        });
      }
      if (current.status === 'UnpublishedViolation') {
        throw new Error(
          `Article ${args.id} was unpublished for a ToS violation; it cannot be republished without moderator action.`
        );
      }

      const input: Record<string, unknown> = {
        id: current.id,
        title: current.title,
        content: current.content,
        coverImage: current.coverImage
          ? {
              id: current.coverImage.id,
              url: current.coverImage.url,
              width: current.coverImage.width,
              height: current.coverImage.height,
              hash: current.coverImage.hash ?? null,
              name: current.coverImage.name ?? 'cover',
              meta: current.coverImage.meta ?? null,
              type: current.coverImage.type ?? 'image',
            }
          : null,
        tags: (current.tags ?? []).map((t) => ({ id: t.id, name: t.name })),
        userNsfwLevel: current.userNsfwLevel,
        status: 'Published',
        publishedAt: new Date().toISOString(),
      };

      if (args.dryRun) {
        return ok(`DRY RUN — would publish article ${args.id}.`, {
          ok: true,
          dryRun: true,
          input,
          metaHint: { publishedAt: ['Date'] },
        });
      }

      const result = await services.trpc.call<{ status?: string; publishedAt?: string | Date }>(
        'article.upsert',
        input,
        'POST',
        { publishedAt: ['Date'] }
      );
      return ok(
        `Article ${args.id} published.\nStatus: ${result.status}\nPublished at: ${displayDate(result.publishedAt)}\nURL: ${services.config.webUrl}/articles/${args.id}`,
        { ok: true, id: args.id, status: result.status, publishedAt: result.publishedAt }
      );
    }
  );

  reg(
    'unpublish_article',
    {
      title: 'Unpublish article',
      description: 'Unpublish a published article via the dedicated article.unpublish endpoint.',
      inputSchema: {
        id: z.number().int().describe('Article ID to unpublish'),
        reason: z.string().optional().describe('Optional reason code'),
        message: z.string().optional().describe('Optional custom message shown to the author'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = { id: args.id };
      if (args.reason) input.reason = args.reason;
      if (args.message) input.customMessage = args.message;
      await services.trpc.call('article.unpublish', input);
      return ok(`Article ${args.id} unpublished.`, { ok: true, id: args.id });
    }
  );

  reg(
    'get_article',
    {
      title: 'Get article',
      description: 'Fetch an article by ID (wraps article.getById): title, status, publishedAt, tags, cover.',
      inputSchema: {
        id: z.number().int().describe('Article ID'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      const current = await services.trpc.call<ArticleRow | null>(
        'article.getById',
        { id: args.id },
        'GET'
      );
      if (!current) throw new Error(`Article ${args.id} not found (or not visible to your account)`);
      const text = [
        `# ${current.title} (ID: ${current.id})`,
        `Status: ${current.status ?? 'Unknown'}  |  Published: ${displayDate(current.publishedAt) ?? 'N/A'}`,
        `Tags: ${(current.tags ?? []).map((t) => t.name).join(', ') || 'none'}`,
        `URL: ${services.config.webUrl}/articles/${current.id}`,
      ].join('\n');
      return ok(text, {
        id: current.id,
        title: current.title,
        status: current.status,
        publishedAt: current.publishedAt,
        tags: (current.tags ?? []).map((t) => t.name),
      });
    }
  );
};
