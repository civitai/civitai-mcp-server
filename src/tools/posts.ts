import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok, type Services } from './helpers.js';
import { uploadImage } from './images.js';

/**
 * Post creation & publishing (post.* / image.*).
 *
 * The flagship community gap: an agent can generate images but, without this,
 * can't share them. `create_post` now wraps the single composite app endpoint
 * `post.createWithImages` (mutation/POST, guarded, MediaWrite):
 *
 *   1. (optional) upload_image for any image given by URL -> UUID
 *   2. build images[] with sequential `index` (the `url` field is the upload UUID,
 *      NOT an http URL — same rule as article covers)
 *   3. ONE call to post.createWithImages (atomic; the server handles cleanup if a
 *      part fails, so there is no orphan-draft window to clean up client-side)
 *
 * post.createWithImages output `publishedAt` is a superjson Date — callers reading
 * structuredContent should treat it as a Date string.
 *
 * Requires the MediaWrite scope on the API key (a Full key works).
 */

interface PostRow {
  id: number;
  title?: string | null;
  detail?: string | null;
  publishedAt?: string | null;
  nsfwLevel?: number;
  imageCount?: number;
  user?: { id?: number; username?: string };
}

interface CreateWithImagesResult {
  id: number;
  title?: string | null;
  detail?: string | null;
  modelVersionId?: number | null;
  collectionId?: number | null;
  publishedAt?: string | null;
  imageIds?: number[];
  nsfwLevel?: number;
}

/** One image to attach. Exactly one of uuid / url is required. */
const postImageInput = z
  .object({
    uuid: z.string().optional().describe('Pre-uploaded image UUID (from upload_image)'),
    url: z.string().url().optional().describe('Remote image URL (uploaded automatically to get a UUID)'),
    width: z.number().int().optional().describe('Image width in px'),
    height: z.number().int().optional().describe('Image height in px'),
    type: z.enum(['image', 'video', 'audio']).optional().describe('Media type (default image)'),
  })
  .refine((v) => !!v.uuid || !!v.url, { message: 'Each image needs a uuid or a url' });

/** Resolve a post image input to the UUID post.createWithImages expects. */
async function resolveImageUuid(
  services: Services,
  img: { uuid?: string; url?: string; width?: number; height?: number }
): Promise<{ uuid: string; width?: number; height?: number }> {
  if (img.uuid) return { uuid: img.uuid, width: img.width, height: img.height };
  const up = await uploadImage(services, { url: img.url! });
  return { uuid: up.uuid, width: img.width ?? up.width, height: img.height ?? up.height };
}

export const postTools: ToolModule = (reg) => {
  reg(
    'create_post',
    {
      title: 'Create (and optionally publish) a post',
      description:
        'Create a Civitai image post and attach images in order. This is the primary way to share creative work. ' +
        'Wraps the composite `post.createWithImages` endpoint in ONE atomic call: the server creates the post, ' +
        'attaches every image (in the given order), and optionally publishes — handling cleanup itself if any part fails. ' +
        'Each image is supplied by a pre-uploaded UUID or a URL (uploaded automatically first). ' +
        'Set publish=true to publish immediately (default false leaves it as a draft you can publish later with publish_post). ' +
        'Requires an onboarded, non-muted account and the MediaWrite scope (a Full API key works).',
      inputSchema: {
        title: z.string().optional().describe('Post title'),
        detail: z.string().optional().describe('Post description/detail (HTML or plain text)'),
        images: z.array(postImageInput).min(1).describe('Images to attach, in order'),
        tags: z.array(z.string()).optional().describe('Tag names'),
        modelVersionId: z
          .number()
          .int()
          .optional()
          .describe('Associate the post (and its images) with this model version id'),
        collectionId: z.number().int().optional().describe('Add the post to this contest/collection'),
        publish: z.boolean().default(false).describe('Publish immediately (else leave as draft)'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();

      // Resolve each image to its upload UUID and build images[] with sequential
      // index. `url` carries the UUID (not an http URL), same as article covers.
      const images: Array<Record<string, unknown>> = [];
      for (let i = 0; i < args.images.length; i++) {
        const src = args.images[i]!;
        const resolved = await resolveImageUuid(services, src);
        const img: Record<string, unknown> = {
          url: resolved.uuid,
          index: i,
          type: src.type ?? 'image',
        };
        if (resolved.width) img.width = resolved.width;
        if (resolved.height) img.height = resolved.height;
        if (args.modelVersionId) img.modelVersionId = args.modelVersionId;
        images.push(img);
      }

      const input: Record<string, unknown> = { images, publish: args.publish };
      if (args.title) input.title = args.title;
      if (args.detail) input.detail = args.detail;
      if (args.tags?.length) input.tags = args.tags;
      if (args.modelVersionId) input.modelVersionId = args.modelVersionId;
      if (args.collectionId) input.collectionId = args.collectionId;

      // One atomic call. publishedAt comes back as a superjson Date.
      const res = await services.trpc.call<CreateWithImagesResult>('post.createWithImages', input);
      if (!res?.id) throw new Error('post.createWithImages did not return an id');

      const imageIds = res.imageIds ?? [];
      const url = `${services.config.apiUrl}/posts/${res.id}`;
      return ok(
        `Post ${args.publish ? 'created and published' : 'created (draft)'}.\nID: ${res.id}\nImages attached: ${imageIds.length}\nURL: ${url}`,
        {
          ok: true,
          id: res.id,
          imageIds,
          published: args.publish,
          publishedAt: res.publishedAt ?? null,
          nsfwLevel: res.nsfwLevel,
          url,
        }
      );
    }
  );

  reg(
    'get_post',
    {
      title: 'Get post',
      description: 'Fetch a post by ID (wraps post.get): title, publishedAt, image count, author.',
      inputSchema: { id: z.number().int().describe('Post ID') },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      const post = await services.trpc.call<PostRow | null>('post.get', { id: args.id }, 'GET');
      if (!post) throw new Error(`Post ${args.id} not found (or not visible to your account)`);
      const text = [
        `Post #${post.id}${post.title ? ` — ${post.title}` : ''}`,
        `By: ${post.user?.username ?? `user#${post.user?.id}`}`,
        `Published: ${post.publishedAt ?? '(draft)'}`,
        `URL: ${services.config.apiUrl}/posts/${post.id}`,
      ].join('\n');
      return ok(text, {
        id: post.id,
        title: post.title,
        publishedAt: post.publishedAt,
        published: !!post.publishedAt,
      });
    }
  );

  reg(
    'publish_post',
    {
      title: 'Publish post',
      description:
        'Publish a draft post by setting publishedAt to now via post.update (with the required superjson Date hint). ' +
        'Idempotent-ish: re-publishing simply re-stamps publishedAt. Requires an onboarded account (post.update is verified).',
      inputSchema: {
        id: z.number().int().describe('Post ID to publish'),
        collectionId: z.number().int().optional().describe('Optionally (re)assign the post to a collection'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = { id: args.id, publishedAt: new Date().toISOString() };
      if (args.collectionId) input.collectionId = args.collectionId;
      const res = await services.trpc.call<PostRow>('post.update', input, 'POST', {
        publishedAt: ['Date'],
      });
      return ok(`Post ${args.id} published.\nURL: ${services.config.apiUrl}/posts/${args.id}`, {
        ok: true,
        id: args.id,
        publishedAt: res?.publishedAt ?? input.publishedAt,
      });
    }
  );

  reg(
    'delete_post',
    {
      title: 'Delete post',
      description: 'Delete a post you own (or any post, if moderator). Wraps post.delete.',
      inputSchema: { id: z.number().int().describe('Post ID to delete') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('post.delete', { id: args.id });
      return ok(`Post ${args.id} deleted.`, { ok: true, id: args.id });
    }
  );
};
