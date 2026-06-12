import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';
import { mdToHtml } from '../lib/markdown.js';
import { uploadImage } from './images.js';

const NSFW_MAP: Record<string, number> = { PG: 1, PG13: 2, R: 4, X: 8, XXX: 16, Blocked: 32 };

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
}

export const articleTools: ToolModule = (reg) => {
  reg(
    'upsert_article',
    {
      title: 'Create or update article',
      description:
        'Create (omit id) or update (pass id) a Civitai article. Markdown content is converted to HTML server-side-safe. Optionally attach a cover by UUID (coverImageUuid) or by URL (coverImageUrl, uploaded automatically). Note: article.upsert requires title+content on every call. To flip publish state use publish_article.',
      inputSchema: {
        title: z.string().describe('Article title'),
        content: z.string().describe('Article body in Markdown (converted to HTML)'),
        id: z.number().int().optional().describe('Existing article ID to update'),
        status: z.enum(['Draft', 'Published']).default('Draft').describe('Draft or Published'),
        nsfwLevel: z
          .enum(['PG', 'PG13', 'R', 'X', 'XXX', 'Blocked'])
          .default('PG')
          .describe('Content rating (userNsfwLevel)'),
        tags: z.array(z.string()).optional().describe('Tag names (lowercased)'),
        coverImageUuid: z.string().optional().describe('Cover image UUID from upload_image'),
        coverImageUrl: z.string().url().optional().describe('Cover image URL (uploaded automatically)'),
        coverWidth: z.number().int().optional().describe('Cover width (when using a UUID)'),
        coverHeight: z.number().int().optional().describe('Cover height (when using a UUID)'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const html = mdToHtml(args.content);
      if (!html || html === '<p></p>') throw new Error('Converted HTML content is empty');

      let coverUuid = args.coverImageUuid;
      let coverW = args.coverWidth;
      let coverH = args.coverHeight;
      if (!coverUuid && args.coverImageUrl) {
        const up = await uploadImage(services, { url: args.coverImageUrl });
        coverUuid = up.uuid;
        coverW = coverW ?? up.width;
        coverH = coverH ?? up.height;
      }

      const input: Record<string, unknown> = {
        title: args.title,
        content: html,
        coverImage: coverUuid
          ? {
              url: coverUuid,
              width: coverW ?? 1024,
              height: coverH ?? 576,
              hash: null,
              name: 'cover.png',
              meta: null,
              type: 'image',
            }
          : null,
        tags: (args.tags ?? []).map((name) => ({ name: name.toLowerCase() })),
        userNsfwLevel: NSFW_MAP[args.nsfwLevel] ?? 1,
        status: args.status,
      };
      if (args.id) input.id = args.id;

      const result = await services.trpc.call<{ id?: number } | number>('article.upsert', input);
      const id = typeof result === 'number' ? result : result?.id;
      return ok(
        `Article ${args.id ? 'updated' : 'created'} as ${args.status}.` +
          (id ? `\nID: ${id}\nView: ${services.config.webUrl}/articles/${id}` : ''),
        { ok: true, id, status: args.status, coverImageUuid: coverUuid }
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
