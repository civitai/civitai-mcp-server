import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';
import { mdToHtml } from '../lib/markdown.js';
import { uploadImage } from './images.js';
import type { MetaValues } from '../client/trpc.js';

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
  publishedAt?: string;
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
  tags?: Array<{ id?: number; name: string }>;
  attachments?: unknown[];
  lockedProperties?: string[];
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
        'UPDATES ARE MERGES: article.upsert overwrites every field it receives and clears every field ' +
        'it does not, so when id is passed this tool first fetches the article and preserves status, ' +
        'publishedAt, cover, tags and nsfw level unless you explicitly override them. ' +
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
          .describe('Tag names (lowercased). On update, omit to keep the current tags; pass [] to clear them.'),
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

      // article.upsert is a full replace, not a patch: any field omitted from the
      // payload is cleared. On update, start from the live record so an unrelated
      // edit cannot null the cover, drop the tags or unpublish the article.
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

      let coverImage: Record<string, unknown> | null;
      if (coverUuid) {
        coverImage = {
          url: coverUuid,
          width: coverW ?? 1024,
          height: coverH ?? 576,
          hash: null,
          name: 'cover.png',
          meta: null,
          type: 'image',
        };
      } else if (current?.coverImage) {
        // Preserve the existing cover verbatim rather than nulling it.
        coverImage = {
          id: current.coverImage.id,
          url: current.coverImage.url,
          width: current.coverImage.width,
          height: current.coverImage.height,
          hash: current.coverImage.hash ?? null,
          name: current.coverImage.name ?? 'cover',
          meta: current.coverImage.meta ?? null,
          type: current.coverImage.type ?? 'image',
        };
      } else {
        coverImage = null;
      }

      const status = args.status ?? current?.status ?? 'Draft';
      const nsfwLevel =
        args.nsfwLevel !== undefined
          ? (NSFW_MAP[args.nsfwLevel] ?? 1)
          : (current?.userNsfwLevel ?? 1);
      const tags =
        args.tags !== undefined
          ? args.tags.map((name) => ({ name: name.toLowerCase() }))
          : (current?.tags ?? []).map((t) => ({ id: t.id, name: t.name }));

      const input: Record<string, unknown> = {
        title: args.title,
        content: html,
        coverImage,
        tags,
        userNsfwLevel: nsfwLevel,
        status,
      };
      if (args.id) input.id = args.id;
      if (current?.attachments) input.attachments = current.attachments;
      if (current?.lockedProperties) input.lockedProperties = current.lockedProperties;

      // publishedAt is z.date() server-side: without the superjson hint it fails to
      // deserialize and a published article silently loses its publish date.
      const metaValues: MetaValues = {};
      if (current?.publishedAt) {
        input.publishedAt = current.publishedAt;
        metaValues.publishedAt = ['Date'];
      }

      const result = await services.trpc.call<{ id?: number } | number>(
        'article.upsert',
        input,
        'POST',
        Object.keys(metaValues).length > 0 ? metaValues : undefined
      );
      const id = typeof result === 'number' ? result : result?.id;
      return ok(
        `Article ${args.id ? 'updated' : 'created'} as ${status}` +
          ` (content sent as ${asHtml ? 'html' : 'markdown'}).` +
          (args.id ? `\nPreserved: status, publishedAt, cover and tags not explicitly overridden.` : '') +
          (id ? `\nID: ${id}\nView: ${services.config.webUrl}/articles/${id}` : ''),
        { ok: true, id, status, contentFormat: asHtml ? 'html' : 'markdown', coverImageUuid: coverUuid }
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
        return ok(`Article ${args.id} is already Published (publishedAt=${current.publishedAt}).`, {
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

      const result = await services.trpc.call<{ status?: string; publishedAt?: string }>(
        'article.upsert',
        input,
        'POST',
        { publishedAt: ['Date'] }
      );
      return ok(
        `Article ${args.id} published.\nStatus: ${result.status}\nPublished at: ${result.publishedAt}\nURL: ${services.config.webUrl}/articles/${args.id}`,
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
        `Status: ${current.status ?? 'Unknown'}  |  Published: ${current.publishedAt ?? 'N/A'}`,
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
