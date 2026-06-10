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

const MAX_CONCURRENCY = 3;

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
    async (args, { rest, config }) => {
      // Validate into locals rather than mutating the SDK-parsed input object.
      const type = args.type ? await rest.validateEnum('type', args.type, 'ModelType') : undefined;
      const sort = args.sort ? await rest.validateEnum('sort', args.sort, 'ModelSort') : undefined;
      const period = args.period
        ? await rest.validateEnum('period', args.period, 'MetricTimeframe')
        : undefined;

      // Meilisearch bug: when query + (type|supportsGeneration) are combined the
      // server ignores the secondary filter. Over-fetch and filter client-side.
      const needsClientFilter = !!args.query && (!!type || !!args.supportsGeneration);

      const params: Record<string, string | number | boolean | undefined> = {
        limit: needsClientFilter ? 100 : args.limit,
        sort: sort ?? 'Highest Rated',
        period: period ?? 'AllTime',
        query: args.query,
        baseModels: args.baseModel,
        tag: args.tag,
        username: args.username,
        cursor: args.cursor,
      };
      // When NOT client-filtering, push type/generation to the API directly.
      if (!args.query) {
        if (type) params.types = type;
        if (args.supportsGeneration) params.supportsGeneration = true;
      }

      const data = await rest.get<{ items?: ModelLite[]; metadata?: { nextCursor?: string } }>(
        '/models',
        params
      );
      let items = data.items ?? [];
      if (needsClientFilter) {
        if (type) items = items.filter((m) => m.type?.toLowerCase() === type.toLowerCase());
        // supportsGeneration isn't on the public shape reliably; type filter is the main fix.
        items = items.slice(0, args.limit);
      }

      const text =
        items.length === 0
          ? 'No models found.' +
            (needsClientFilter ? ' (results returned but none matched the type filter)' : '')
          : `Found ${items.length} model(s):\n\n` +
            items.map((m, i) => formatModelResult(m, i, config.apiUrl)).join('\n\n');

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
          blocks.push(formatModelDetail(r.value, config.apiUrl));
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
        if (r.ok) blocks.push(formatVersionDetail(r.value, config.apiUrl));
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
    async (args, { rest }) => {
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
        'Fetch full generation metadata for image(s) by ID (batch, concurrency 3): prompt, negative prompt, sampler, steps, CFG, seed, and the resources used. There is no /images/:id endpoint upstream; this queries /images?imageId=<id>&withMeta=true.',
      inputSchema: {
        ids: z.array(z.number().int()).min(1).max(20).describe('Image IDs to fetch'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { rest, config }) => {
      const results = await mapWithConcurrency(args.ids, MAX_CONCURRENCY, async (id) => {
        const data = await rest.get<{ items?: ImageLite[] }>('/images', {
          imageId: id,
          withMeta: true,
        });
        const item = data.items?.[0];
        if (!item) throw new Error(`No image found with ID ${id}`);
        return item;
      });
      const blocks: string[] = [];
      const errors: Array<{ id: number; error: string }> = [];
      for (const r of results) {
        if (r.ok) blocks.push(formatImageDetail(r.value, config.apiUrl));
        else errors.push({ id: r.item, error: r.error });
      }
      let text = blocks.join('\n\n' + '='.repeat(50) + '\n\n');
      if (errors.length) text += `\n\nFailed: ${errors.map((e) => `${e.id} (${e.error})`).join(', ')}`;
      return ok(text || 'No images fetched.', { errors });
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
