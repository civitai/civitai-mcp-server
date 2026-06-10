import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok, type Services } from './helpers.js';
import { uploadImage } from './images.js';

/**
 * Bounties (bounty.* + bountyEntry.*). Flag-gated `bounties` end-to-end.
 *
 * IMPORTANT — blockApiKeys: `bounty.upsert` sets meta.blockApiKeys:true
 * (bounty.router.ts:89), so it rejects this server's API-key auth. We use
 * `bounty.create` / `bounty.update` instead, which are plain guarded procedures
 * WITHOUT blockApiKeys (verified). `bountyEntry.upsert` and `bountyEntry.award`
 * are also clean (no blockApiKeys).
 *
 * Verified shapes:
 *  - bounty.create (guarded, BountiesWrite): { name, description, unitAmount,
 *    currency, startsAt(Date), expiresAt(Date), mode, type, entryMode,
 *    minBenefactorUnitAmount, images[>=1, uuid-based], ... }. startsAt/expiresAt
 *    are z.date()/coerce -> need the ['Date'] superjson hint.
 *  - bounty.update (guarded, owner-checked): subset + { id, startsAt, expiresAt }.
 *  - bountyEntry.upsert (guarded): { id?, bountyId, files[>=1], images[>=1], ... }.
 *  - bountyEntry.award (protected): { id }.
 */

const CURRENCIES = ['BUZZ', 'USD'] as const;
const BOUNTY_MODES = ['Individual', 'Split'] as const;
const BOUNTY_TYPES = [
  'ModelCreation',
  'LoraCreation',
  'EmbedCreation',
  'DataSetCreation',
  'DataSetCaption',
  'ImageCreation',
  'VideoCreation',
  'Other',
] as const;
const ENTRY_MODES = ['Open', 'BenefactorsOnly'] as const;

/** An example image for a bounty / entry. UUID or URL (uploaded automatically). */
const exampleImageInput = z
  .object({
    uuid: z.string().optional().describe('Pre-uploaded image UUID'),
    url: z.string().url().optional().describe('Remote image URL (uploaded automatically)'),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  })
  .refine((v) => !!v.uuid || !!v.url, { message: 'Each image needs a uuid or url' });

async function resolveImages(
  services: Services,
  images: Array<{ uuid?: string; url?: string; width?: number; height?: number }>
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const img of images) {
    let uuid = img.uuid;
    let width = img.width;
    let height = img.height;
    if (!uuid) {
      const up = await uploadImage(services, { url: img.url! });
      uuid = up.uuid;
      width = width ?? up.width;
      height = height ?? up.height;
    }
    out.push({ url: uuid, type: 'image', ...(width ? { width } : {}), ...(height ? { height } : {}) });
  }
  return out;
}

export const bountyTools: ToolModule = (reg) => {
  reg(
    'create_bounty',
    {
      title: 'Create a bounty',
      description:
        'Create a bounty via bounty.create (NOT bounty.upsert — upsert is blocked for API keys). Requires an onboarded, ' +
        'non-muted account and the `bounties` feature flag. At least one example image is required (by UUID or URL). ' +
        'startsAt/expiresAt are dates (ISO strings here; the Date superjson hint is applied). Funding spends Buzz.',
      inputSchema: {
        name: z.string().describe('Bounty name'),
        description: z.string().describe('Bounty description (HTML or plain text)'),
        unitAmount: z.number().int().describe('Bounty reward amount (in the chosen currency unit)'),
        currency: z.enum(CURRENCIES).default('BUZZ').describe('Reward currency'),
        startsAt: z.string().describe('Start date (ISO timestamp, must be today or later)'),
        expiresAt: z.string().describe('Expiration date (ISO timestamp, must be after start)'),
        mode: z.enum(BOUNTY_MODES).default('Individual').describe('Award mode'),
        type: z.enum(BOUNTY_TYPES).describe('Bounty type'),
        entryMode: z.enum(ENTRY_MODES).default('Open').describe('Who may submit entries'),
        minBenefactorUnitAmount: z
          .number()
          .int()
          .min(1)
          .describe('Minimum amount a benefactor must contribute'),
        entryLimit: z.number().int().min(1).optional().describe('Max entries allowed'),
        nsfw: z.boolean().optional().describe('Mark NSFW'),
        tags: z.array(z.string()).optional().describe('Tag names'),
        images: z.array(exampleImageInput).min(1).describe('Example image(s) — at least one required'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const images = await resolveImages(services, args.images);
      const input: Record<string, unknown> = {
        name: args.name,
        description: args.description,
        unitAmount: args.unitAmount,
        currency: args.currency,
        startsAt: new Date(args.startsAt).toISOString(),
        expiresAt: new Date(args.expiresAt).toISOString(),
        mode: args.mode,
        type: args.type,
        entryMode: args.entryMode,
        minBenefactorUnitAmount: args.minBenefactorUnitAmount,
        images,
      };
      if (args.entryLimit) input.entryLimit = args.entryLimit;
      if (args.nsfw !== undefined) input.nsfw = args.nsfw;
      if (args.tags?.length) input.tags = args.tags.map((name) => ({ name }));
      const res = await services.trpc.call<{ id?: number }>('bounty.create', input, 'POST', {
        startsAt: ['Date'],
        expiresAt: ['Date'],
      });
      const id = res?.id;
      return ok(
        `Bounty created: "${args.name}"${id ? ` (id ${id})` : ''}.` +
          (id ? `\nURL: ${services.config.apiUrl}/bounties/${id}` : ''),
        { ok: true, id, name: args.name }
      );
    }
  );

  reg(
    'update_bounty',
    {
      title: 'Update a bounty',
      description:
        'Update a bounty you own via bounty.update (owner-checked, guarded, `bounties` flag). Pass only the fields to change; ' +
        'startsAt/expiresAt and at least one image are still required by the schema, so include current images by UUID.',
      inputSchema: {
        id: z.number().int().describe('Bounty ID'),
        name: z.string().describe('Bounty name'),
        description: z.string().describe('Bounty description'),
        type: z.enum(BOUNTY_TYPES).describe('Bounty type'),
        startsAt: z.string().describe('Start date (ISO timestamp)'),
        expiresAt: z.string().describe('Expiration date (ISO timestamp)'),
        entryLimit: z.number().int().min(1).optional().describe('Max entries allowed'),
        nsfw: z.boolean().optional().describe('Mark NSFW'),
        tags: z.array(z.string()).optional().describe('Tag names'),
        images: z.array(exampleImageInput).min(1).describe('Example image(s) — at least one required'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const images = await resolveImages(services, args.images);
      const input: Record<string, unknown> = {
        id: args.id,
        name: args.name,
        description: args.description,
        type: args.type,
        startsAt: new Date(args.startsAt).toISOString(),
        expiresAt: new Date(args.expiresAt).toISOString(),
        images,
      };
      if (args.entryLimit) input.entryLimit = args.entryLimit;
      if (args.nsfw !== undefined) input.nsfw = args.nsfw;
      if (args.tags?.length) input.tags = args.tags.map((name) => ({ name }));
      await services.trpc.call('bounty.update', input, 'POST', {
        startsAt: ['Date'],
        expiresAt: ['Date'],
      });
      return ok(`Bounty ${args.id} updated.`, { ok: true, id: args.id });
    }
  );

  reg(
    'create_bounty_entry',
    {
      title: 'Submit a bounty entry',
      description:
        'Submit an entry to a bounty via bountyEntry.upsert (guarded, `bounties` flag). Requires at least one file (the ' +
        'deliverable, as an uploaded file descriptor) and at least one example image. Files must already be uploaded; pass ' +
        'their descriptors. Pass id to edit an existing entry.',
      inputSchema: {
        bountyId: z.number().int().describe('Bounty ID being entered'),
        id: z.number().int().optional().describe('Existing entry id to edit'),
        files: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .describe('Deliverable file descriptors (baseFileSchema shape: { url, name, sizeKB, ... }), at least one'),
        images: z.array(exampleImageInput).min(1).describe('Example image(s) — at least one required'),
        description: z.string().optional().describe('Entry description (Markdown/HTML, sanitized)'),
        ownRights: z.boolean().optional().describe('Assert you own the rights to the deliverable'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const images = await resolveImages(services, args.images);
      const input: Record<string, unknown> = {
        bountyId: args.bountyId,
        files: args.files,
        images,
      };
      if (args.id) input.id = args.id;
      if (args.description) input.description = args.description;
      if (args.ownRights !== undefined) input.ownRights = args.ownRights;
      const res = await services.trpc.call<{ id?: number }>('bountyEntry.upsert', input);
      return ok(
        `Bounty entry ${args.id ? 'updated' : 'submitted'} for bounty ${args.bountyId} (entry ${res?.id ?? '(unknown)'}).`,
        { ok: true, id: res?.id, bountyId: args.bountyId }
      );
    }
  );

  reg(
    'award_bounty',
    {
      title: 'Award a bounty to an entry',
      description:
        'Award a bounty to a specific entry via bountyEntry.award { id }. Protected + `bounties` flag. Only the bounty owner ' +
        'may award; awarding distributes the bounty funds to the entry author.',
      inputSchema: {
        entryId: z.number().int().describe('Bounty ENTRY id to award (not the bounty id)'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      await services.trpc.call('bountyEntry.award', { id: args.entryId });
      return ok(`Awarded bounty to entry ${args.entryId}.`, { ok: true, entryId: args.entryId });
    }
  );
};
