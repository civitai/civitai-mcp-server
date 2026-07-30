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

/** Row shape from article.getInfinite (metadata only — no body). */
interface ArticleListRow {
  id: number;
  title: string;
  publishedAt?: string | null;
  status?: string;
  unlisted?: boolean;
  availability?: string;
  nsfwLevel?: number;
  createdAt?: string;
  updatedAt?: string;
  tags?: Array<{ id?: number; name: string; isCategory?: boolean }>;
  stats?: Record<string, number>;
  user?: { id?: number; username?: string };
}

/** Upstream ArticleSort values, verbatim — they are spaced strings, not enum keys. */
const ARTICLE_SORTS = [
  'Newest',
  'Recently Updated',
  'Most Reactions',
  'Most Comments',
  'Most Collected',
  'Most Bookmarks',
] as const;

const ARTICLE_PERIODS = ['AllTime', 'Year', 'Month', 'Week', 'Day'] as const;

export const articleTools: ToolModule = (reg) => {
  reg(
    'list_articles',
    {
      title: 'List articles',
      description:
        "Search / list articles (wraps article.getInfinite). Filter by author username, free-text query, or numeric tag ids. " +
        "Paginate by passing the previous call's `nextCursor` straight back as `cursor`. " +
        'Returns metadata only — no article bodies. Fetch a body with get_article includeContent=true, one article at a time.',
      inputSchema: {
        username: z.string().optional().describe('Only articles by this author'),
        query: z.string().optional().describe('Free-text search over titles'),
        tagIds: z
          .array(z.number().int())
          .optional()
          .describe('Numeric tag ids (upstream filters by id, not name — read ids off a previous result)'),
        sort: z.enum(ARTICLE_SORTS).default('Newest').describe('Sort order'),
        period: z.enum(ARTICLE_PERIODS).default('AllTime').describe('Metric timeframe the sort applies over'),
        limit: z.number().int().min(1).max(100).default(20).describe('Page size (max 100)'),
        cursor: z
          .string()
          .optional()
          .describe('Opaque cursor from a previous nextCursor. Pass it through unchanged.'),
        includeDrafts: z
          .boolean()
          .optional()
          .describe('Include your own unpublished articles (ignored for other authors)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      const input: Record<string, unknown> = {
        limit: args.limit,
        sort: args.sort,
        period: args.period,
      };
      if (args.username) input.username = args.username;
      if (args.query) input.query = args.query;
      if (args.tagIds?.length) input.tags = args.tagIds;
      if (args.includeDrafts !== undefined) input.includeDrafts = args.includeDrafts;
      // nextCursor is an object ({v, id}); it is round-tripped as an opaque JSON
      // string so agents never have to understand or rebuild it.
      if (args.cursor) {
        try {
          input.cursor = JSON.parse(args.cursor);
        } catch {
          throw new Error('cursor must be the nextCursor value from a previous list_articles call');
        }
      }

      const res = await services.trpc.call<{
        items?: ArticleListRow[];
        nextCursor?: unknown;
      }>('article.getInfinite', input, 'GET');

      const items = res?.items ?? [];
      const nextCursor = res?.nextCursor == null ? null : JSON.stringify(res.nextCursor);

      const lines = items.map((a) => {
        const when = a.publishedAt ? String(a.publishedAt).slice(0, 10) : 'unpublished';
        const flags = [a.status && a.status !== 'Published' ? a.status : '', a.unlisted ? 'unlisted' : '']
          .filter(Boolean)
          .join(' ');
        const st = a.stats ?? {};
        return `#${a.id}\t${when}\t${st.viewCount ?? 0}v ${st.likeCount ?? 0}l ${st.commentCount ?? 0}c${flags ? ' [' + flags + ']' : ''}\t${a.title}`;
      });

      return ok(
        (lines.join('\n') || 'No articles.') +
          `\n\n(${items.length} article(s)${nextCursor ? ', more available — pass nextCursor as cursor' : ''})`,
        {
          count: items.length,
          nextCursor,
          articles: items.map((a) => ({
            id: a.id,
            title: a.title,
            username: a.user?.username ?? null,
            publishedAt: a.publishedAt ?? null,
            status: a.status ?? null,
            unlisted: a.unlisted ?? null,
            availability: a.availability ?? null,
            createdAt: a.createdAt ?? null,
            updatedAt: a.updatedAt ?? null,
            tags: (a.tags ?? []).map((t) => ({ id: t.id ?? null, name: t.name })),
            stats: {
              viewCount: a.stats?.viewCount ?? 0,
              likeCount: a.stats?.likeCount ?? 0,
              commentCount: a.stats?.commentCount ?? 0,
              collectedCount: a.stats?.collectedCount ?? 0,
            },
            url: `${services.config.webUrl}/articles/${a.id}`,
          })),
        }
      );
    }
  );

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
      description:
        'Fetch an article by ID (wraps article.getById): title, status, publishedAt, tags, cover, and the ' +
        'body length. The body itself is opt-in via includeContent — it is HTML (not Markdown) and runs ' +
        '20-45k characters, so bulk pulls belong on disk rather than in a context window.',
      inputSchema: {
        id: z.number().int().describe('Article ID'),
        includeContent: z
          .boolean()
          .default(false)
          .describe(
            'Include the article body as HTML. Off by default because bodies are 20-45k chars. ' +
              'Converting HTML to Markdown is the caller\'s job.'
          ),
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
      const contentLength = current.content?.length ?? 0;
      return ok(text + `\nBody: ${contentLength} chars of HTML${args.includeContent ? '' : ' (pass includeContent=true to fetch it)'}`, {
        id: current.id,
        title: current.title,
        status: current.status,
        publishedAt: current.publishedAt,
        tags: (current.tags ?? []).map((t) => t.name),
        contentLength,
        contentFormat: 'html',
        // Opt-in: article.getById always returns the body, but forwarding it by
        // default would put 20-45k chars per article into the caller's context.
        ...(args.includeContent ? { content: current.content } : {}),
      });
    }
  );
};
