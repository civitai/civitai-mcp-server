import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';

/**
 * Collections (collection.*). Flag-gated `collections` upstream end-to-end
 * (except collection.upsert itself, which is only guarded). If the feature flag
 * is off for the account/environment the procedure throws — surface that clearly
 * as "feature disabled," not a bug.
 *
 * Verified shapes:
 *  - collection.upsert: guarded, CollectionsWrite. upsertCollectionInput
 *    { id?, name(<=30), description?(<=300), type(default Model), read?, write?, nsfw?, ... }.
 *  - collection.saveItem: protected, flag-gated. saveCollectionItemInputSchema
 *    requires EXACTLY ONE of articleId/imageId/postId/modelId, plus a
 *    collections[] array of { collectionId, tagId? }.
 *  - collection.follow: protected, flag-gated. { collectionId, userId? }.
 */

const COLLECTION_TYPES = ['Model', 'Image', 'Post', 'Article'] as const;
const ITEM_TYPES = ['Model', 'Image', 'Post', 'Article'] as const;

export const collectionTools: ToolModule = (reg) => {
  reg(
    'upsert_collection',
    {
      title: 'Create or update a collection',
      description:
        'Create (omit id) or update (pass id) a collection via collection.upsert. Requires an onboarded, non-muted account ' +
        '(guarded). Flag-gated `collections` upstream — if the feature is disabled for the account the call errors with a ' +
        'feature/flag message rather than succeeding.',
      inputSchema: {
        name: z.string().max(30).describe('Collection name (max 30 chars)'),
        id: z.number().int().optional().describe('Existing collection id to update'),
        description: z.string().max(300).optional().describe('Description (max 300 chars)'),
        type: z.enum(COLLECTION_TYPES).default('Model').describe('What kind of items the collection holds'),
        nsfw: z.boolean().optional().describe('Mark the collection NSFW'),
        read: z
          .enum(['Private', 'Public', 'Unlisted'])
          .optional()
          .describe('Read access configuration'),
        write: z
          .enum(['Private', 'Public', 'Review'])
          .optional()
          .describe('Who can add items'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = { name: args.name, type: args.type };
      if (args.id) input.id = args.id;
      if (args.description !== undefined) input.description = args.description;
      if (args.nsfw !== undefined) input.nsfw = args.nsfw;
      if (args.read) input.read = args.read;
      if (args.write) input.write = args.write;
      const res = await services.trpc.call<{ id?: number }>('collection.upsert', input);
      const id = res?.id ?? args.id;
      return ok(
        `Collection ${args.id ? 'updated' : 'created'}: "${args.name}"${id ? ` (id ${id})` : ''}.`,
        { ok: true, id, name: args.name, type: args.type }
      );
    }
  );

  reg(
    'add_to_collection',
    {
      title: 'Add an item to collection(s)',
      description:
        'Save a single item (one of an article, image, post, or model) into one or more collections via collection.saveItem. ' +
        'You must pass exactly one of articleId/imageId/postId/modelId, and at least one collectionId. ' +
        'Protected and flag-gated `collections` — a disabled flag errors out. ' +
        'To find your default bookmark collection id, list your collections first.',
      inputSchema: {
        itemType: z.enum(ITEM_TYPES).describe('The kind of item being saved'),
        itemId: z.number().int().describe('The id of the item (matched to itemType)'),
        collectionIds: z.array(z.number().int()).min(1).describe('Collection id(s) to add the item to'),
        note: z.string().optional().describe('Optional note attached to the saved item'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = {
        type: args.itemType,
        collections: args.collectionIds.map((collectionId) => ({ collectionId })),
      };
      if (args.note) input.note = args.note;
      // Set exactly one of the id fields to match itemType.
      const idField = `${args.itemType.toLowerCase()}Id`;
      input[idField] = args.itemId;
      await services.trpc.call('collection.saveItem', input);
      return ok(
        `Saved ${args.itemType.toLowerCase()} ${args.itemId} to collection(s): ${args.collectionIds.join(', ')}.`,
        { ok: true, itemType: args.itemType, itemId: args.itemId, collectionIds: args.collectionIds }
      );
    }
  );

  reg(
    'follow_collection',
    {
      title: 'Follow / unfollow a collection',
      description:
        'Follow a collection via collection.follow (use unfollow=true to unfollow). Protected and flag-gated `collections`.',
      inputSchema: {
        collectionId: z.number().int().describe('Collection ID'),
        unfollow: z.boolean().default(false).describe('Unfollow instead of follow'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const procedure = args.unfollow ? 'collection.unfollow' : 'collection.follow';
      await services.trpc.call(procedure, { collectionId: args.collectionId });
      return ok(`${args.unfollow ? 'Unfollowed' : 'Followed'} collection ${args.collectionId}.`, {
        ok: true,
        collectionId: args.collectionId,
        following: !args.unfollow,
      });
    }
  );
};
