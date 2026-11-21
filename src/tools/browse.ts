import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok, mapWithConcurrency } from './helpers.js';
import {
  formatModelResult,
  formatModelDetail,
  formatVersionDetail,
  formatImageResult,
  formatImageDetail,
  modelAirUrns,
  type ModelLite,
  type ImageLite,
} from '../lib/format.js';
import { allowsAllLevels, TrpcError, type TrpcClient } from '../client/trpc.js';
import type { AuthContext } from '../client/auth.js';
import { isProcessingIngestion, PROCESSING_ADVICE } from '../lib/ingestion.js';

const MAX_CONCURRENCY = 3;

interface ProcessingImage {
  id: number;
  ingestion: string;
  postId: number | null;
}

/** What `image.get` says about an image REST did not return. */
type Fallback =
  | { kind: 'processing'; image: ProcessingImage }
  /** Visible to this caller and scanned, but REST did not return it (e.g. rated above the caller's browsing level). */
  | { kind: 'hidden' }
  /** The key lacks the scope `image.get` needs (MediaRead), so nothing could be checked. */
  | { kind: 'unchecked' };

/**
 * What an image REST did not return is, for this caller. REST `/images` drops
 * an unscanned image for everyone, its owner included. `image.get` is the
 * site's own single-image read: it answers NOT_FOUND unless this caller may see
 * the image, and it shows an unscanned, unrated image to its owner and
 * moderators only. So "processing" (or "exists but hidden") is said only where
 * the site already tells this caller the image exists, never more widely.
 *
 * Only with the caller's own key: an HTTP request that fell back to the
 * deployment's env key would otherwise read that account's images. A 403 is
 * the key missing `image.get`'s MediaRead scope (`create_post` needs only
 * MediaWrite); any other failure keeps the plain "not found".
 */
async function imageGetFallback(
  id: number,
  trpc: TrpcClient,
  auth: AuthContext
): Promise<Fallback | null> {
  // keyIsCaller is false with no key at all, so this also covers the anonymous caller.
  if (!auth.keyIsCaller) return null;
  let image: { id?: unknown; ingestion?: unknown; postId?: unknown } | null;
  try {
    image = await trpc.call('image.get', { id }, 'GET');
  } catch (err) {
    return err instanceof TrpcError && err.status === 403 ? { kind: 'unchecked' } : null;
  }
  if (image?.id !== id) return null;
  if (isProcessingIngestion(image.ingestion)) {
    return {
      kind: 'processing',
      image: {
        id,
        ingestion: image.ingestion as string,
        postId: typeof image.postId === 'number' ? image.postId : null,
      },
    };
  }
  return image.ingestion === 'Scanned' ? { kind: 'hidden' } : null;
}

export const browseTools: ToolModule = (reg) => {
  reg(
    'search_models',
    {
      title: 'Search models',
      description:
        'Search Civitai models (checkpoints, LoRAs, embeddings, etc). Returns names, base models, stats, trigger words, and AIR URNs for use with generation. Supports filtering by type, base model, tag, creator, and generation capability. Returns nextCursor for pagination.',
      inputSchema: {
        query: z.string().optional().describe('Free-text search over model names/keywords'),
        type: z
          .string()
          .optional()
          .describe('Model type filter, e.g. Checkpoint, LORA, TextualInversion (validated against enums)'),
        baseModel: z.string().optional().describe('Base model filter, e.g. "SDXL 1.0", "Pony", "Flux.1 D"'),
        sort: z.string().optional().describe('Sort order (default "Highest Rated")'),
        period: z.string().optional().describe('Timeframe (default "AllTime")'),
        tag: z.string().optional().describe('Filter by tag name'),
        username: z.string().optional().describe('Filter by creator username'),
        supportsGeneration: z.boolean().optional().describe('Only models that support on-site generation'),
        limit: z.number().int().min(1).max(100).default(12).describe('Max results to return'),
        cursor: z.string().optional().describe('Pagination cursor from a previous result'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { rest, trpc, config }) => {
      // Validate into locals rather than mutating the SDK-parsed input object.
      const type = args.type ? await rest.validateEnum('type', args.type, 'ModelType') : undefined;
      const sort = args.sort ? await rest.validateEnum('sort', args.sort, 'ModelSort') : undefined;
      const period = args.period
        ? await rest.validateEnum('period', args.period, 'MetricTimeframe')
        : undefined;

      const params: Record<string, string | number | boolean | undefined> = {
        limit: args.limit,
        sort: sort ?? 'Highest Rated',
        period: period ?? 'AllTime',
        query: args.query,
        types: type,
        baseModels: args.baseModel,
        tag: args.tag,
        username: args.username,
        supportsGeneration: args.supportsGeneration || undefined,
        cursor: args.cursor,
      };
      // /models takes only a boolean nsfw (true = every level), so it is sent
      // only for a user who allows every level. Anything less stays at PG.
      if (allowsAllLevels(await trpc.getBrowsingLevel())) params.nsfw = true;

      const data = await rest.get<{ items?: ModelLite[]; metadata?: { nextCursor?: string } }>(
        '/models',
        params
      );
      const items = data.items ?? [];

      const sfwNote = params.nsfw ? '' : '\n\nResults are limited to safe-for-work models.';
      const text =
        (items.length === 0
          ? 'No models found.'
          : `Found ${items.length} model(s):\n\n` +
            items.map((m, i) => formatModelResult(m, i, config.webUrl)).join('\n\n')) + sfwNote;

      return ok(text, {
        count: items.length,
        nextCursor: data.metadata?.nextCursor,
        models: items.map((m) => ({ id: m.id, name: m.name, type: m.type, air: modelAirUrns(m) })),
      });
    }
  );

  reg(
    'get_model',
    {
      title: 'Get model details',
      description:
        'Fetch full details for one or more models by ID (batch, concurrency 3): all versions, files, trigger words, and AIR URNs.',
      inputSchema: {
        ids: z.array(z.number().int()).min(1).max(20).describe('Model IDs to fetch'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { rest, config }) => {
      const results = await mapWithConcurrency(args.ids, MAX_CONCURRENCY, (id) =>
        rest.get<ModelLite>(`/models/${id}`)
      );
      const blocks: string[] = [];
      const structured: unknown[] = [];
      const errors: Array<{ id: number; error: string }> = [];
      for (const r of results) {
        if (r.ok) {
          blocks.push(formatModelDetail(r.value, config.webUrl));
          structured.push({ id: r.value.id, name: r.value.name, air: modelAirUrns(r.value) });
        } else {
          errors.push({ id: r.item, error: r.error });
        }
      }
      let text = blocks.join('\n\n' + '='.repeat(50) + '\n\n');
      if (errors.length) text += `\n\nFailed: ${errors.map((e) => `${e.id} (${e.error})`).join(', ')}`;
      return ok(text || 'No models fetched.', { models: structured, errors });
    }
  );

  reg(
    'get_model_version',
    {
      title: 'Get model version details',
      description:
        'Fetch model version details by version ID (batch, concurrency 3): files, hashes, trigger words, and the AIR URN for generation.',
      inputSchema: {
        ids: z.array(z.number().int()).min(1).max(20).describe('Model version IDs to fetch'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { rest, config }) => {
      const results = await mapWithConcurrency(args.ids, MAX_CONCURRENCY, (id) =>
        rest.get<Parameters<typeof formatVersionDetail>[0]>(`/model-versions/${id}`)
      );
      const blocks: string[] = [];
      const errors: Array<{ id: number; error: string }> = [];
      for (const r of results) {
        if (r.ok) blocks.push(formatVersionDetail(r.value, config.webUrl));
        else errors.push({ id: r.item, error: r.error });
      }
      let text = blocks.join('\n\n' + '='.repeat(50) + '\n\n');
      if (errors.length) text += `\n\nFailed: ${errors.map((e) => `${e.id} (${e.error})`).join(', ')}`;
      return ok(text || 'No versions fetched.', { errors });
    }
  );

  reg(
    'search_images',
    {
      title: 'Search images',
      description:
        'Search Civitai images with full generation metadata (prompt, negative, sampler, steps, CFG, seed, resources). Filter by query, model, version, base model, creator, type. Returns nextCursor for pagination.',
      inputSchema: {
        query: z.string().optional().describe('Free-text search over prompts/tags'),
        modelId: z.number().int().optional().describe('Filter to images made with this model'),
        modelVersionId: z.number().int().optional().describe('Filter to images made with this version'),
        baseModel: z.string().optional().describe('Filter by base model used'),
        username: z.string().optional().describe('Filter by creator username'),
        sort: z.string().optional().describe('Sort order (default "Most Reactions")'),
        period: z.string().optional().describe('Timeframe (default "AllTime")'),
        type: z.string().optional().describe('"image" or "video"'),
        limit: z.number().int().min(1).max(100).default(12).describe('Max results'),
        cursor: z.string().optional().describe('Pagination cursor'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { rest, trpc }) => {
      const sort = args.sort ? await rest.validateEnum('sort', args.sort, 'ImageSort') : undefined;
      const period = args.period
        ? await rest.validateEnum('period', args.period, 'MetricTimeframe')
        : undefined;
      const data = await rest.get<{ items?: ImageLite[]; metadata?: { nextCursor?: string } }>('/images', {
        limit: args.limit,
        sort: sort ?? 'Most Reactions',
        period: period ?? 'AllTime',
        withMeta: true,
        query: args.query,
        modelId: args.modelId,
        modelVersionId: args.modelVersionId,
        baseModels: args.baseModel,
        username: args.username,
        type: args.type,
        cursor: args.cursor,
        browsingLevel: await trpc.getBrowsingLevel(),
      });
      const items = data.items ?? [];
      const text =
        items.length === 0
          ? 'No images found.'
          : `Found ${items.length} image(s):\n\n` + items.map((m, i) => formatImageResult(m, i)).join('\n\n');
      return ok(text, {
        count: items.length,
        nextCursor: data.metadata?.nextCursor,
        images: items.map((i) => ({ id: i.id, postId: i.postId, modelVersionIds: i.modelVersionIds })),
      });
    }
  );

  reg(
    'get_image',
    {
      title: 'Get image details',
      description:
        'Fetch full generation metadata for image(s) by ID (batch, concurrency 3): prompt, negative prompt, sampler, steps, CFG, seed, and the resources used. There is no /images/:id endpoint upstream; this queries /images?imageId=<id>&withMeta=true. ' +
        'A new image stays hidden until its scan finishes: with your own API key (MediaRead scope), your own not-yet-scanned image is listed under `processing` instead of failing as not found.',
      inputSchema: {
        ids: z.array(z.number().int()).min(1).max(20).describe('Image IDs to fetch'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { rest, trpc, config, auth }) => {
      const browsingLevel = await trpc.getBrowsingLevel();
      const results = await mapWithConcurrency(
        args.ids,
        MAX_CONCURRENCY,
        async (id): Promise<{ image: ImageLite } | { processing: ProcessingImage }> => {
          const data = await rest.get<{ items?: ImageLite[] }>('/images', {
            imageId: id,
            withMeta: true,
            browsingLevel,
          });
          const item = data.items?.[0];
          if (item) return { image: item };
          const fallback = await imageGetFallback(id, trpc, auth);
          if (fallback?.kind === 'processing') return { processing: fallback.image };
          if (fallback?.kind === 'hidden') {
            throw new Error(
              `Image ${id} exists but the image search does not return it for you (for example, it is rated above your browsing level)`
            );
          }
          if (fallback?.kind === 'unchecked') {
            throw new Error(
              `No image found with ID ${id} (could not check whether it is still processing: your API key lacks the MediaRead scope)`
            );
          }
          throw new Error(`No image found with ID ${id}`);
        }
      );
      const blocks: string[] = [];
      const processing: ProcessingImage[] = [];
      const errors: Array<{ id: number; error: string }> = [];
      for (const r of results) {
        if (!r.ok) errors.push({ id: r.item, error: r.error });
        else if ('image' in r.value) blocks.push(formatImageDetail(r.value.image, config.webUrl));
        else processing.push(r.value.processing);
      }
      let text = blocks.join('\n\n' + '='.repeat(50) + '\n\n');
      if (processing.length) {
        const lines = processing.map(
          (p) => `Image ${p.id} is still processing (ingestion: ${p.ingestion}).`
        );
        text += `${text ? '\n\n' : ''}${lines.join('\n')}\n${PROCESSING_ADVICE}`;
      }
      if (errors.length) text += `\n\nFailed: ${errors.map((e) => `${e.id} (${e.error})`).join(', ')}`;
      return ok(text || 'No images fetched.', { processing, errors });
    }
  );

  reg(
    'search_creators',
    {
      title: 'Search creators',
      description: 'Search Civitai creators/users by name. Returns username and model count.',
      inputSchema: {
        query: z.string().optional().describe('Free-text search over usernames'),
        limit: z.number().int().min(1).max(200).default(20).describe('Max results'),
        cursor: z.string().optional().describe('Pagination cursor'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { rest }) => {
      const data = await rest.get<{
        items?: Array<{ username?: string; modelCount?: number }>;
        metadata?: { nextCursor?: string };
      }>('/creators', { query: args.query, limit: args.limit, cursor: args.cursor });
      const items = data.items ?? [];
      const text =
        items.length === 0
          ? 'No creators found.'
          : `Creators (${items.length}):\n` +
            items.map((c) => `  - ${c.username} (${c.modelCount ?? 0} models)`).join('\n');
      return ok(text, { count: items.length, nextCursor: data.metadata?.nextCursor, creators: items });
    }
  );

  reg(
    'list_enums',
    {
      title: 'List enums',
      description:
        'List the Civitai API enum values usable for filtering (model types, sorts, base models, timeframes, etc). Use this to discover valid values before searching.',
      inputSchema: {
        filter: z.string().optional().describe('Only return the enum whose key matches (case-insensitive)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { rest }) => {
      const enums = await rest.fetchEnums();
      const entries = Object.entries(enums).filter(
        ([k]) => !args.filter || k.toLowerCase().includes(args.filter.toLowerCase())
      );
      const text = entries
        .map(([k, v]) => `${k}:\n  ${Array.isArray(v) ? v.join(', ') : JSON.stringify(v)}`)
        .join('\n\n');
      return ok(text || 'No matching enums.', { enums: Object.fromEntries(entries) });
    }
  );
};
