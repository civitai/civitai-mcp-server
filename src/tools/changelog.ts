import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';
import { mdToHtml } from '../lib/markdown.js';

const TYPES = ['Feature', 'Bugfix', 'Policy', 'Update', 'Incident'] as const;
const TITLE_COLORS = ['blue', 'purple', 'red', 'orange', 'yellow', 'green'] as const;
const DOMAINS = ['all', 'red', 'green', 'blue'] as const;

function toIso(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d.toISOString();
}

export const changelogTools: ToolModule = (reg) => {
  reg(
    'upsert_changelog',
    {
      title: 'Create or update changelog entry (moderator)',
      description:
        'Create (omit id) or update (pass id) a /changelog entry. Markdown content is converted to HTML (same converter as articles). On create, title + content + type are required and effectiveAt defaults to now. On update, only the fields you pass are changed. Moderator-only, gated by the changelogEdit flag.',
      inputSchema: {
        id: z.number().int().optional().describe('Existing entry ID to update'),
        title: z.string().optional().describe('Entry title (required on create)'),
        content: z.string().optional().describe('Body Markdown (converted to HTML; required on create)'),
        type: z.enum(TYPES).optional().describe('Entry type (required on create)'),
        titleColor: z.enum(TITLE_COLORS).optional().describe('Title color (default blue on create)'),
        link: z.string().optional().describe('Reference link (commit, article, etc)'),
        cta: z.string().optional().describe('Call-to-action button URL'),
        effectiveAt: z
          .string()
          .optional()
          .describe('Effective time (ISO or YYYY-MM-DD); future hides from non-mods. Defaults to now on create.'),
        tags: z.array(z.string()).optional().describe('Tag names'),
        domains: z.array(z.enum(DOMAINS)).optional().describe('Domain scope (default ["all"] on create)'),
        sticky: z.boolean().optional().describe('Pin to top of feed'),
        disabled: z.boolean().optional().describe('Hide the entry'),
        dryRun: z.boolean().optional().describe('Build the payload but do not send it'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const isUpdate = !!args.id;
      const payload: Record<string, unknown> = {};

      if (args.title !== undefined) payload.title = args.title;
      if (args.titleColor !== undefined) payload.titleColor = args.titleColor;
      if (args.content !== undefined) payload.content = mdToHtml(args.content);
      if (args.link !== undefined) payload.link = args.link;
      if (args.cta !== undefined) payload.cta = args.cta;
      if (args.type !== undefined) payload.type = args.type;
      if (args.tags !== undefined) payload.tags = args.tags;
      if (args.domains?.length) payload.domain = args.domains;
      if (args.sticky !== undefined) payload.sticky = args.sticky;
      if (args.disabled !== undefined) payload.disabled = args.disabled;
      if (args.effectiveAt !== undefined) payload.effectiveAt = toIso(args.effectiveAt);
      else if (!isUpdate) payload.effectiveAt = new Date().toISOString();

      if (!isUpdate) {
        if (!payload.title) throw new Error('title is required on create');
        if (!payload.content) throw new Error('content is required on create');
        if (!payload.type) throw new Error('type is required on create');
        if (!payload.titleColor) payload.titleColor = 'blue';
        if (!payload.domain) payload.domain = ['all'];
      } else {
        payload.id = args.id;
        if (Object.keys(payload).length === 1) {
          throw new Error('Nothing to update — provide at least one field besides id');
        }
      }

      const procedure = isUpdate ? 'changelog.update' : 'changelog.create';
      const metaHint = payload.effectiveAt ? { effectiveAt: ['Date'] } : undefined;

      if (args.dryRun) {
        return ok(`DRY RUN — would ${procedure}.`, { ok: true, dryRun: true, input: payload, metaHint });
      }

      const result = await services.trpc.call<{ id?: number } | number>(procedure, payload, 'POST', metaHint);
      const id = typeof result === 'number' ? result : result?.id;
      return ok(`Changelog ${isUpdate ? 'updated' : 'created'}.${id ? ` ID: ${id}` : ''}`, {
        ok: true,
        id,
        url: `${services.config.apiUrl}/changelog`,
      });
    }
  );
};
