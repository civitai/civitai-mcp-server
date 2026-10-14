import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { SERVER_VERSION } from '../version.js';
import {
  LIMITS,
  PLATFORM_FEEDBACK_ABOUT,
  PLATFORM_FEEDBACK_CREATE,
  PLATFORM_FEEDBACK_DOC_URL_PREFIX,
  PLATFORM_FEEDBACK_GET_STATUS,
  PLATFORM_FEEDBACK_KINDS,
  STATUS_REF_RE,
  alignStatusItems,
  buildPlatformFeedbackInput,
  normalizeStatusRefs,
  platformFeedbackFailure,
  type PlatformFeedbackCreateResult,
} from '../lib/platform-feedback.js';
import { ok } from './helpers.js';

/**
 * Developer-platform feedback (platformFeedback.create / .getStatus), the same
 * channel as `civitai feedback send|status` in the Civitai CLI. Both procedures
 * need the AppBlocksSubmit token scope (a full-access personal key passes) and
 * are gated by a Civitai feature flag; the wire contract, redaction and error
 * mapping live in src/lib/platform-feedback.ts.
 */

/** The raw excerpt an agent may hand over; it is redacted, then cut to the server's 500. */
const ERROR_EXCERPT_INPUT_MAX = 20_000;

const SCOPE_NOTE =
  'Needs a Civitai API key with the AppBlocksSubmit scope ("Manage your Apps"); a full-access personal API key works.';

const quote = (s: string) => JSON.stringify(s);

export const platformFeedbackTools: ToolModule = (reg) => {
  reg(
    'send_platform_feedback',
    {
      title: 'Send Civitai platform feedback',
      description:
        'Tell Civitai that its developer platform got in your way: a bug, a confusing or missing piece, or a ' +
        'request, in the Civitai CLI, an SDK, the developer docs, app review, the sandbox, token scopes, or this ' +
        'MCP server. Use it when the problem is in Civitai\'s platform; do NOT use it for bugs in the app you ' +
        'are building, for feedback about a Civitai app or model, or for site support. ' +
        'Give a short message plus whatever structured detail you have (about, kind, a site key in `ref`, the ' +
        'command or tool, an HTTP status, an error excerpt, the docs URL). This server adds its own name and ' +
        'version. Every free-text field is scrubbed before it leaves this server (URL credentials and query ' +
        'strings, Authorization headers, known token formats, KEY=value secrets, e-mail addresses, home-directory ' +
        'user names), but scrubbing matches shapes and misses some: do not paste secrets. ' +
        'Returns a ref; pass it to get_platform_feedback_status later to see whether Civitai acknowledged or ' +
        `fixed it. A matching earlier report is counted rather than duplicated. ${SCOPE_NOTE}`,
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(LIMITS.message)
          .describe('What went wrong or what is missing, in plain words (max 2000 characters).'),
        about: z
          .enum(PLATFORM_FEEDBACK_ABOUT)
          .describe('Which part of the platform: cli, sdk, docs, review, sandbox, scopes, mcp (this server), or other.'),
        kind: z
          .enum(PLATFORM_FEEDBACK_KINDS)
          .optional()
          .describe('bug (default), confusing, missing, or request.'),
        ref: z
          .string()
          .max(LIMITS.ref)
          .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/)
          .optional()
          .describe(
            'Optional site key naming WHERE it failed, e.g. "submit.server-refused" (lowercase a-z, 0-9, . _ -). ' +
              'Reports sharing a site key are counted together. Not the ref this tool returns.'
          ),
        command: z
          .string()
          .max(LIMITS.command)
          .optional()
          .describe('The command or tool call that failed, e.g. "civitai app submit" (max 120 characters).'),
        httpStatus: z.number().int().min(100).max(599).optional().describe('The HTTP status you got, if any.'),
        exitCode: z.number().int().min(0).max(255).optional().describe('The process exit code, if a command failed.'),
        errorExcerpt: z
          .string()
          .max(ERROR_EXCERPT_INPUT_MAX)
          .optional()
          .describe('The relevant error output. Scrubbed, then cut to the first 500 characters.'),
        docUrl: z
          .string()
          .max(LIMITS.docUrl)
          .startsWith(PLATFORM_FEEDBACK_DOC_URL_PREFIX)
          .optional()
          .describe(`The docs page involved; must start with ${PLATFORM_FEEDBACK_DOC_URL_PREFIX}.`),
        appSlug: z.string().max(LIMITS.appSlug).optional().describe('The slug of the app you were working on, if any.'),
        agent: z
          .string()
          .max(LIMITS.agent)
          .optional()
          .describe('Which agent you are, e.g. "claude-code" (max 40 characters).'),
        os: z.string().max(LIMITS.os).optional().describe('Your operating system, e.g. "linux" (max 16).'),
        arch: z.string().max(LIMITS.arch).optional().describe('Your CPU architecture, e.g. "arm64" (max 16).'),
        sdk: z
          .array(
            z.object({
              name: z.string().min(1).max(LIMITS.sdkName),
              version: z.string().min(1).max(LIMITS.version),
            })
          )
          .max(LIMITS.sdk)
          .optional()
          .describe('Up to 4 SDK packages and versions in use, e.g. [{"name":"@civitai/app-sdk","version":"0.69.0"}].'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, services) => {
      try {
        const key = services.auth.requireKey();
        const { input, redactions, excerptClipped } = buildPlatformFeedbackInput(args, SERVER_VERSION, {
          tokens: [key],
          home: services.config.transport === 'stdio' ? homedir() : undefined,
        });
        const res = await services.trpc.call<PlatformFeedbackCreateResult>(PLATFORM_FEEDBACK_CREATE, input, 'POST');

        const lines = [
          res.duplicate
            ? `Civitai already had this report; yours was counted on it. Ref: ${res.ref}`
            : `Sent. Ref: ${res.ref}`,
          `Status: ${res.status}` +
            (res.reporters > 1 ? ` (${res.reporters} reporters)` : '') +
            (res.fixedIn ? ` — fixed in ${res.fixedIn.component} ${res.fixedIn.version}` : ''),
        ];
        // The note is text Civitai wrote; it is quoted as data, not instructions.
        if (res.note) lines.push(`Civitai's note: ${quote(res.note)}`);
        if (redactions.length) {
          lines.push(`Removed before sending: ${redactions.map((r) => `${r.count} ${r.kind}`).join(', ')}.`);
        }
        if (excerptClipped) lines.push(`The error excerpt was cut to its first ${LIMITS.errorExcerpt} characters after scrubbing.`);
        lines.push(`To check on it later, call get_platform_feedback_status with refs: [${quote(res.ref)}].`);

        return ok(lines.join('\n'), {
          ref: res.ref,
          duplicate: res.duplicate,
          status: res.status,
          fixedIn: res.fixedIn ?? null,
          note: res.note ?? null,
          reporters: res.reporters,
          redactions,
          excerptClipped,
          hint: 'Pass ref to get_platform_feedback_status to read its status later.',
        });
      } catch (err) {
        return platformFeedbackFailure(err, services.config.webUrl);
      }
    }
  );

  reg(
    'get_platform_feedback_status',
    {
      title: 'Get Civitai platform feedback status',
      description:
        'Read back what Civitai did with platform feedback you sent with send_platform_feedback: received, ' +
        'acknowledged, fixed (with the version it shipped in), addressed, or not_planned, plus Civitai\'s public ' +
        'note and how many people reported it. Pass 1 to 50 refs exactly as send_platform_feedback returned ' +
        `them. A ref Civitai does not hold, or will not show you, comes back found: false. ${SCOPE_NOTE}`,
      inputSchema: {
        refs: z
          .array(z.string().max(LIMITS.statusRef).regex(STATUS_REF_RE))
          .min(1)
          .max(LIMITS.statusRefs)
          .describe('1 to 50 feedback refs, e.g. ["5123-3f9a01bc"].'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, services) => {
      try {
        services.auth.requireKey();
        const refs = normalizeStatusRefs(args.refs);
        const got = await services.trpc.call<unknown>(PLATFORM_FEEDBACK_GET_STATUS, { refs }, 'GET');
        const items = alignStatusItems(refs, got);

        const lines = items.map((it) => {
          if (!it.found) return `${it.ref}: not found`;
          let line = `${it.ref}: ${it.status}`;
          if (it.fixedIn) line += ` — fixed in ${it.fixedIn.component} ${it.fixedIn.version}`;
          if (it.reporters > 1) line += ` (${it.reporters} reporters)`;
          if (it.updatedAt) line += `, updated ${it.updatedAt}`;
          if (it.note) line += `\n  Civitai's note: ${quote(it.note)}`;
          return line;
        });
        return ok(lines.join('\n'), { items });
      } catch (err) {
        return platformFeedbackFailure(err, services.config.webUrl);
      }
    }
  );
};
