import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';
import { commentToHtml } from '../lib/markdown.js';

/**
 * Lightweight community engagement: reactions, resource reviews, follow /
 * favorite / bookmark toggles, and onboarding.
 *
 * Notes verified against the app:
 *  - reaction.toggle: guarded, SocialWrite, fire-and-forget (returns void and
 *    swallows errors) — a 200 does NOT confirm the new state.
 *  - reaction.toggle entityType enum = reactableEntities (reaction.schema.ts).
 *  - resourceReview.upsert: guarded, SocialWrite; details is sanitized HTML.
 *  - user.toggleFollow: verified; user.toggleFavorite: protected (explicit setTo);
 *    user.toggleBookmarkedArticle: verified, input { id }.
 *  - user.completeOnboardingStep: protected, discriminated union on numeric step.
 */

// The real reactable entity set (reaction.schema.ts reactableEntities). Note this
// differs from the comment entity list: `comment` here = modern commentV2 thread.
const REACTABLE_ENTITIES = [
  'question',
  'answer',
  'comment',
  'commentOld',
  'image',
  'post',
  'resourceReview',
  'article',
  'bountyEntry',
  'clubPost',
] as const;

const REACTIONS = ['Like', 'Dislike', 'Laugh', 'Cry', 'Heart'] as const;

// OnboardingSteps enum values (server/common/enums.ts) — the discriminated union
// keys on the NUMERIC value, so we map friendly names to those numbers.
const ONBOARDING_STEPS = {
  TOS: 1,
  Profile: 2,
  BrowsingLevels: 4,
  Buzz: 8,
  RedTOS: 64,
} as const;

export const engagementTools: ToolModule = (reg) => {
  reg(
    'react',
    {
      title: 'React to an entity',
      description:
        'Toggle a reaction (Like, Dislike, Laugh, Cry, Heart) on an image, post, article, comment, resourceReview, etc. ' +
        'Toggling the same reaction again removes it. Requires an onboarded, non-muted account (reaction.toggle is guarded). ' +
        'CAVEAT: this call is fire-and-forget server-side — it returns void and swallows errors, so a success here does NOT ' +
        'confirm the reaction landed. Re-read the entity to verify. `comment` here means a modern (commentV2) thread comment.',
      inputSchema: {
        entityType: z.enum(REACTABLE_ENTITIES).describe('Type of entity being reacted to'),
        entityId: z.number().int().describe('Entity ID'),
        reaction: z.enum(REACTIONS).describe('Reaction type'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('reaction.toggle', {
        entityType: args.entityType,
        entityId: args.entityId,
        reaction: args.reaction,
      });
      return ok(
        `Toggled ${args.reaction} on ${args.entityType}#${args.entityId}. (fire-and-forget — re-read the entity to confirm)`,
        { ok: true, entityType: args.entityType, entityId: args.entityId, reaction: args.reaction }
      );
    }
  );

  reg(
    'upsert_resource_review',
    {
      title: 'Review a model (star rating + recommend)',
      description:
        'Create or update your review of a model version: a numeric star rating (1-5), a recommend flag, and optional ' +
        'written details (Markdown, converted to the restricted review HTML). Uses resourceReview.upsert so re-reviewing ' +
        'edits your existing review instead of erroring. Requires an onboarded, non-muted account (guarded).',
      inputSchema: {
        modelId: z.number().int().describe('Model ID'),
        modelVersionId: z.number().int().describe('Model version ID being reviewed'),
        rating: z.number().min(1).max(5).describe('Star rating, 1-5'),
        recommended: z.boolean().default(true).describe('Whether you recommend this resource'),
        details: z.string().optional().describe('Written review body (Markdown)'),
        id: z.number().int().optional().describe('Existing review id to update (else a new review is created)'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = {
        modelId: args.modelId,
        modelVersionId: args.modelVersionId,
        rating: args.rating,
        recommended: args.recommended,
        details: args.details ? commentToHtml(args.details) : null,
      };
      if (args.id) input.id = args.id;
      const res = await services.trpc.call<{ id?: number }>('resourceReview.upsert', input);
      return ok(
        `Review ${args.id ? 'updated' : 'submitted'} for model version ${args.modelVersionId} (rating ${args.rating}/5, recommended=${args.recommended}). Review ID: ${res?.id ?? '(unknown)'}`,
        { ok: true, id: res?.id, modelVersionId: args.modelVersionId, rating: args.rating }
      );
    }
  );

  reg(
    'get_my_resource_review',
    {
      title: 'Get my review of a model version',
      description: 'Fetch your existing review for a model version (resourceReview.getUserResourceReview), or null.',
      inputSchema: {
        modelVersionId: z.number().int().describe('Model version ID'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, services) => {
      services.auth.requireKey();
      type Review = {
        id?: number;
        rating?: number;
        recommended?: boolean;
        details?: string;
      };
      const res = await services.trpc.call<Review | Review[] | null>(
        'resourceReview.getUserResourceReview',
        { modelVersionId: args.modelVersionId },
        'GET'
      );
      // Upstream answers `[]` when there is no review — truthy, so the `!res` guard
      // never fired and the tool asserted `reviewed: true` with every field
      // undefined. Unwrap the array shape and key off the id instead.
      const review = Array.isArray(res) ? res[0] : res;
      if (!review || review.id == null) {
        return ok(`You have not reviewed model version ${args.modelVersionId}.`, { reviewed: false });
      }
      return ok(
        `Your review of model version ${args.modelVersionId}: ${review.rating}/5, recommended=${review.recommended} (id ${review.id}).`,
        {
          reviewed: true,
          id: review.id,
          rating: review.rating,
          recommended: review.recommended,
          details: review.details,
        }
      );
    }
  );

  reg(
    'toggle_follow_user',
    {
      title: 'Follow / unfollow a user',
      description:
        'Toggle following a user (by numeric id or username). user.toggleFollow flips the follow state, so calling it again ' +
        'unfollows. Requires an onboarded account (verified). Pass a username and it is resolved to the numeric targetUserId first.',
      inputSchema: {
        user: z.union([z.string(), z.number()]).describe('Target user: numeric id or username'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const target = await services.trpc.lookupUser(args.user);
      if (!target) throw new Error(`User '${args.user}' not found`);
      await services.trpc.call('user.toggleFollow', { targetUserId: target.id, username: target.username });
      return ok(`Toggled follow on ${target.username} (id ${target.id}).`, {
        ok: true,
        targetUserId: target.id,
        username: target.username,
      });
    }
  );

  reg(
    'toggle_favorite_model',
    {
      title: 'Favorite / bookmark a model',
      description:
        'Add or remove a model from your favorites/bookmarks via user.toggleFavorite. Unlike most toggles this takes an ' +
        'explicit setTo flag (true = favorite, false = remove). This is the bookmark action; use notify_model for new-version ' +
        'notifications instead. Protected (no onboarding gate).',
      inputSchema: {
        modelId: z.number().int().describe('Model ID'),
        modelVersionId: z.number().int().optional().describe('Optional specific model version'),
        setTo: z.boolean().default(true).describe('true = favorite, false = un-favorite'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = { modelId: args.modelId, setTo: args.setTo };
      if (args.modelVersionId) input.modelVersionId = args.modelVersionId;
      await services.trpc.call('user.toggleFavorite', input);
      return ok(`Model ${args.modelId} ${args.setTo ? 'favorited' : 'un-favorited'}.`, {
        ok: true,
        modelId: args.modelId,
        favorited: args.setTo,
      });
    }
  );

  reg(
    'notify_model',
    {
      title: 'Toggle new-version notifications for a model',
      description:
        'Toggle the "notify me of new versions" engagement on a model via user.toggleNotifyModel. This is distinct from ' +
        'favoriting (use toggle_favorite_model to bookmark). Protected.',
      inputSchema: {
        modelId: z.number().int().describe('Model ID'),
        type: z
          .string()
          .optional()
          .describe('ModelEngagementType (e.g. Notify); omit for the default notify toggle'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const input: Record<string, unknown> = { modelId: args.modelId };
      if (args.type) input.type = args.type;
      await services.trpc.call('user.toggleNotifyModel', input);
      return ok(`Toggled model ${args.modelId} notification engagement.`, { ok: true, modelId: args.modelId });
    }
  );

  reg(
    'toggle_bookmark_article',
    {
      title: 'Bookmark / un-bookmark an article',
      description:
        'Toggle bookmarking an article via user.toggleBookmarkedArticle (input { id }). Calling again removes the bookmark. ' +
        'Requires an onboarded account (verified).',
      inputSchema: {
        articleId: z.number().int().describe('Article ID'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('user.toggleBookmarkedArticle', { id: args.articleId });
      return ok(`Toggled bookmark on article ${args.articleId}.`, { ok: true, articleId: args.articleId });
    }
  );

  reg(
    'complete_onboarding_step',
    {
      title: 'Complete an onboarding step',
      description:
        'Complete one onboarding step for the current account via user.completeOnboardingStep. A brand-new account cannot ' +
        'perform ANY verified/guarded social write (post, react, review, follow, etc.) until onboarding is finished, so this ' +
        'is a prerequisite. Steps: TOS, RedTOS, Profile (needs username+email), BrowsingLevels, Buzz (needs a recaptcha token, ' +
        'usually not completable headlessly). Run once per step. The Buzz step typically must be done in a real browser session.',
      inputSchema: {
        step: z
          .enum(['TOS', 'RedTOS', 'Profile', 'BrowsingLevels', 'Buzz'])
          .describe('Onboarding step to complete'),
        username: z.string().optional().describe('Required for the Profile step'),
        email: z.string().optional().describe('Required for the Profile step'),
        recaptchaToken: z.string().optional().describe('Required for the Buzz step'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const stepValue = ONBOARDING_STEPS[args.step];
      const input: Record<string, unknown> = { step: stepValue };
      if (args.step === 'Profile') {
        if (!args.username || !args.email)
          throw new Error('The Profile onboarding step requires both username and email.');
        input.username = args.username;
        input.email = args.email;
      }
      if (args.step === 'Buzz') {
        if (!args.recaptchaToken)
          throw new Error(
            'The Buzz onboarding step requires a recaptchaToken, which generally cannot be obtained headlessly — complete it in a browser session.'
          );
        input.recaptchaToken = args.recaptchaToken;
      }
      await services.trpc.call('user.completeOnboardingStep', input);
      return ok(`Completed onboarding step: ${args.step}.`, { ok: true, step: args.step });
    }
  );
};
