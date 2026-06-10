import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok, type Services } from './helpers.js';
import { uploadImage } from './images.js';

/**
 * Post creation & publishing (post.* / image.*).
 *
 * The flagship community gap: an agent can generate images but, without this,
 * can't share them. `create_post` chains the full flow behind one tool:
 *
 *   1. (optional) upload_image for any image given by URL -> UUID
 *   2. post.create            (guarded, MediaWrite) -> { id }
 *   3. post.addImage x N      (guarded, MediaWrite, ordered by index)
 *   4. (optional) post.update { id, publishedAt } to publish (verified, MediaWrite)
 *
 * post.addImage's `url` field is a z.string().uuid() (image.schema.ts imageSchema)
 * — it is the upload UUID, NOT an http URL (same rule as article covers).
 * publishedAt is a z.date() so it needs the ['Date'] superjson hint.
 *
 * ORPHAN CLEANUP: if addImage or publish fails after post.create succeeds, we
 * attempt post.delete to remove the empty draft and report the partial state.
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

/** Resolve a post image input to the UUID post.addImage expects. */
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
        'Chains post.create -> post.addImage (one call per image, ordered) -> optional publish via post.update { publishedAt }. ' +
        'Each image is supplied by a pre-uploaded UUID or a URL (uploaded automatically). ' +
        'Set publish=true to publish immediately (default false leaves it as a draft you can publish later with publish_post). ' +
        'Requires an onboarded, non-muted account (post.create is a guarded procedure). ' +
        'If attaching images or publishing fails after the post is created, the draft post is deleted and the partial state reported.',
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
        nsfwLevel: z
          .number()
          .int()
          .optional()
          .describe('NSFW level override (normally derived server-side from image scanning)'),
        collectionId: z.number().int().optional().describe('Add the post to this contest/collection'),
        publish: z.boolean().default(false).describe('Publish immediately (else leave as draft)'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();

      // 1. Create the (draft) post.
      const createInput: Record<string, unknown> = {};
      if (args.title) createInput.title = args.title;
      if (args.detail) createInput.detail = args.detail;
      if (args.tags?.length) createInput.tags = args.tags;
      if (args.modelVersionId) createInput.modelVersionId = args.modelVersionId;
      if (args.collectionId) createInput.collectionId = args.collectionId;
      const post = await services.trpc.call<PostRow>('post.create', createInput);
      if (!post?.id) throw new Error('post.create did not return an id');

      // 2. Attach images in order. On any failure, clean up the orphan draft.
      const attached: number[] = [];
      try {
        for (let i = 0; i < args.images.length; i++) {
          const resolved = await resolveImageUuid(services, args.images[i]!);
          const addInput: Record<string, unknown> = {
            postId: post.id,
            url: resolved.uuid,
            index: i,
            type: args.images[i]!.type ?? 'image',
          };
          if (resolved.width) addInput.width = resolved.width;
          if (resolved.height) addInput.height = resolved.height;
          if (args.modelVersionId) addInput.modelVersionId = args.modelVersionId;
          const added = await services.trpc.call<{ id?: number }>('post.addImage', addInput);
          if (added?.id) attached.push(added.id);
        }

        // 3. Optionally publish.
        if (args.publish) {
          const updateInput: Record<string, unknown> = {
            id: post.id,
            publishedAt: new Date().toISOString(),
          };
          if (args.collectionId) updateInput.collectionId = args.collectionId;
          await services.trpc.call('post.update', updateInput, 'POST', { publishedAt: ['Date'] });
        }
      } catch (err) {
        // ORPHAN CLEANUP: try to delete the draft so we don't leave debris.
        let cleanup = 'draft left in place (delete failed)';
        try {
          await services.trpc.call('post.delete', { id: post.id });
          cleanup = 'draft post deleted';
        } catch {
          /* report below; nothing more we can do */
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Post ${post.id} created but failed after ${attached.length}/${args.images.length} image(s): ${reason}. Cleanup: ${cleanup}.`
        );
      }

      const url = `${services.config.apiUrl}/posts/${post.id}`;
      return ok(
        `Post ${args.publish ? 'created and published' : 'created (draft)'}.\nID: ${post.id}\nImages attached: ${attached.length}\nURL: ${url}`,
        {
          ok: true,
          id: post.id,
          imageIds: attached,
          published: args.publish,
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
