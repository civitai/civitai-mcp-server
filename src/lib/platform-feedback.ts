import { TrpcError } from '../client/trpc.js';
import type { ToolResult } from '../tools/helpers.js';
import { Redactor, type RedactionCount } from './redact.js';

/**
 * Civitai developer-platform feedback (`platformFeedback.create` /
 * `platformFeedback.getStatus`): an agent telling Civitai that the platform —
 * CLI, SDK, docs, review, sandbox, scopes, this MCP server — got in its way,
 * and reading back whether it is known or fixed.
 *
 * 🔴 THIS FILE IS THE ONE PLACE THE WIRE CONTRACT LIVES in this server:
 * procedure names, field names, enums, bounds, the redaction applied before
 * sending, and the error mapping. It mirrors the server's schema
 * (civitai/civitai `src/server/schema/platform-feedback.schema.ts`) and the CLI's
 * client (civitai/cli `internal/appapi/platform_feedback.go`). Every bound is
 * enforced HERE, because the server rejects an oversize value rather than
 * clipping it.
 */

export const PLATFORM_FEEDBACK_CREATE = 'platformFeedback.create';
export const PLATFORM_FEEDBACK_GET_STATUS = 'platformFeedback.getStatus';

/** report.client.name for this server. The server maps it to the `mcp` component for fix-version checks. */
export const PLATFORM_FEEDBACK_CLIENT_NAME = 'civitai-mcp';

export const PLATFORM_FEEDBACK_ABOUT = ['cli', 'sdk', 'docs', 'review', 'sandbox', 'scopes', 'mcp', 'other'] as const;
export const PLATFORM_FEEDBACK_KINDS = ['bug', 'confusing', 'missing', 'request'] as const;
export const PLATFORM_FEEDBACK_DOC_URL_PREFIX = 'https://developer.civitai.com/';

/** Server bounds, in UTF-16 code units (zod's `.max()` is JavaScript's `.length`). */
export const LIMITS = {
  message: 2000,
  ref: 80,
  version: 32,
  agent: 40,
  os: 16,
  arch: 16,
  command: 120,
  sdk: 4,
  sdkName: 40,
  docUrl: 300,
  errorExcerpt: 500,
  appSlug: 64,
  statusRefs: 50,
  statusRef: 80,
} as const;

/** report.ref: a caller-chosen SITE KEY for the failure (e.g. `submit.server-refused`), not a server ref. */
export const REPORT_REF_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** A server-issued report ref (e.g. `5123-3f9a01bc`), held to the CLI's conservative shape. */
export const STATUS_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;
/** A NUL or an unpaired surrogate: Postgres stores neither, and the server refuses both. */
const UNSTORABLE_RE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export type PlatformFeedbackAbout = (typeof PLATFORM_FEEDBACK_ABOUT)[number];
export type PlatformFeedbackKind = (typeof PLATFORM_FEEDBACK_KINDS)[number];

/** What the agent supplies. client name/version are filled in by this server, never asked for. */
export interface SendPlatformFeedbackArgs {
  message: string;
  about: PlatformFeedbackAbout;
  kind?: PlatformFeedbackKind;
  ref?: string;
  command?: string;
  httpStatus?: number;
  exitCode?: number;
  errorExcerpt?: string;
  docUrl?: string;
  appSlug?: string;
  agent?: string;
  os?: string;
  arch?: string;
  sdk?: Array<{ name: string; version: string }>;
}

export interface PlatformFeedbackReport {
  about: PlatformFeedbackAbout;
  kind: PlatformFeedbackKind;
  ref?: string;
  client: { name: typeof PLATFORM_FEEDBACK_CLIENT_NAME; version: string };
  agent?: string;
  os?: string;
  arch?: string;
  command?: string;
  exitCode?: number;
  httpStatus?: number;
  sdk?: Array<{ name: string; version: string }>;
  docUrl?: string;
  errorExcerpt?: string;
  appSlug?: string;
}

export interface PlatformFeedbackCreateInput {
  message: string;
  report: PlatformFeedbackReport;
}

export interface PlatformFeedbackCreateResult {
  ref: string;
  duplicate: boolean;
  status: string;
  fixedIn: { component: string; version: string } | null;
  note: string | null;
  reporters: number;
  reports: number;
}

export type PlatformFeedbackStatusItem =
  | {
      ref: string;
      found: true;
      status: string;
      fixedIn: { component: string; version: string } | null;
      note: string | null;
      reporters: number;
      firstSeenAt: string | null;
      updatedAt: string | null;
    }
  | { ref: string; found: false };

/** A refusal decided on this side of the wire: nothing was sent. */
export class PlatformFeedbackInputError extends Error {
  constructor(readonly field: string, problem: string) {
    super(`${field} ${problem} — nothing was sent`);
    this.name = 'PlatformFeedbackInputError';
  }
}

/** Server-owned fields of the input: never agent text, so never scrubbed. */
const NOT_FREE_TEXT = new Set(['report.about', 'report.kind', 'report.client.name', 'report.client.version']);

/** Fields cut (after redaction) rather than refused when too long. Only the excerpt: it is an excerpt. */
const CLIP_AFTER_REDACTION: Record<string, number> = { 'report.errorExcerpt': LIMITS.errorExcerpt };

/** Makes text storable: NUL removed, an unpaired surrogate becomes U+FFFD (the CLI's CleanText). */
function cleanText(s: string): string {
  return s.replace(/\u0000/g, '').replace(LONE_SURROGATE_RE, '�');
}

export interface ScrubOptions {
  /** Credential values to remove exactly — the API key this request is made with. */
  tokens: Array<string | undefined>;
  /** Home directory to replace with `~` (stdio mode only; an in-cluster server's home is not the agent's). */
  home?: string;
}

export interface ScrubResult {
  input: PlatformFeedbackCreateInput;
  redactions: RedactionCount[];
  excerptClipped: boolean;
  skippedShortTokens: number;
}

/**
 * 🔴 THE ONE SCRUB POINT. Assembles the outgoing input and runs EVERY string in
 * it through one Redactor — by walking the assembled object, not by naming
 * fields, so a field added to the report later is scrubbed without anyone
 * remembering to. Only the server-owned values in NOT_FREE_TEXT are exempt.
 * Then it validates the result against every server bound, then it checks the
 * whole serialised request for the API key as a last gate. Nothing that fails
 * any of the three is returned.
 */
export function buildPlatformFeedbackInput(
  args: SendPlatformFeedbackArgs,
  clientVersion: string,
  opts: ScrubOptions
): ScrubResult {
  const report: PlatformFeedbackReport = {
    about: args.about,
    kind: args.kind ?? 'bug',
    client: { name: PLATFORM_FEEDBACK_CLIENT_NAME, version: clientVersion },
  };
  // Absent when unset, never a zero value: `httpStatus: 0` would be refused.
  const optional = [
    'ref', 'agent', 'os', 'arch', 'command', 'exitCode', 'httpStatus', 'sdk', 'docUrl', 'errorExcerpt', 'appSlug',
  ] as const;
  for (const key of optional) {
    const value = args[key];
    if (value !== undefined && value !== '') (report as unknown as Record<string, unknown>)[key] = value;
  }
  if (report.sdk) report.sdk = report.sdk.map((s) => ({ ...s }));

  const red = new Redactor({ home: opts.home, tokens: opts.tokens });
  let excerptClipped = false;
  const scrub = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (NOT_FREE_TEXT.has(path)) return value;
      const text = cleanText(value);
      const max = CLIP_AFTER_REDACTION[path];
      if (max !== undefined) {
        const { text: clipped, clipped: cut } = red.applyClipped(text, max);
        excerptClipped ||= cut;
        return clipped;
      }
      return red.apply(text);
    }
    if (Array.isArray(value)) return value.map((v, i) => scrub(v, `${path}[${i}]`));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, scrub(v, path ? `${path}.${k}` : k)])
      );
    }
    return value;
  };
  const scrubbed = scrub({ message: args.message, report }, '') as PlatformFeedbackCreateInput;
  scrubbed.message = scrubbed.message.trim();
  if (scrubbed.report.errorExcerpt === '') delete scrubbed.report.errorExcerpt;

  // A site key is validated, not free text: if redaction changed it, it held something credential-shaped.
  if (args.ref !== undefined && args.ref !== '' && scrubbed.report.ref !== args.ref) {
    throw new PlatformFeedbackInputError('ref', 'looks like it contains a credential; use a short site key such as `submit.server-refused`');
  }

  validatePlatformFeedbackInput(scrubbed);
  refuseIfTokenInRequest(scrubbed, red.tokens());

  return {
    input: scrubbed,
    redactions: red.countsList(),
    excerptClipped,
    skippedShortTokens: red.skippedShortTokens(),
  };
}

/**
 * Every bound and enum of the server's schema, checked on what will be SENT
 * (after redaction, which can lengthen text). Mirrors the CLI's Validate.
 */
export function validatePlatformFeedbackInput(input: PlatformFeedbackCreateInput): void {
  const fail = (field: string, problem: string): never => {
    throw new PlatformFeedbackInputError(field, problem);
  };
  const { message, report: r } = input;
  if (message.length < 1 || message.length > LIMITS.message) {
    fail('message', `must be 1 to ${LIMITS.message} characters after redaction, got ${message.length}`);
  }
  const texts: Array<[string, string | undefined]> = [
    ['message', message],
    ['ref', r.ref],
    ['agent', r.agent],
    ['os', r.os],
    ['arch', r.arch],
    ['command', r.command],
    ['docUrl', r.docUrl],
    ['errorExcerpt', r.errorExcerpt],
    ['appSlug', r.appSlug],
    ...(r.sdk ?? []).flatMap((s, i): Array<[string, string]> => [
      [`sdk[${i}].name`, s.name],
      [`sdk[${i}].version`, s.version],
    ]),
  ];
  for (const [field, value] of texts) {
    if (value !== undefined && UNSTORABLE_RE.test(value)) fail(field, 'must not contain a NUL or an unpaired surrogate');
  }
  if (!(PLATFORM_FEEDBACK_ABOUT as readonly string[]).includes(r.about)) {
    fail('about', `must be one of ${PLATFORM_FEEDBACK_ABOUT.join(', ')}`);
  }
  if (!(PLATFORM_FEEDBACK_KINDS as readonly string[]).includes(r.kind)) {
    fail('kind', `must be one of ${PLATFORM_FEEDBACK_KINDS.join(', ')}`);
  }
  if (r.ref !== undefined && !REPORT_REF_RE.test(r.ref)) {
    fail('ref', `must be 1 to ${LIMITS.ref} characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit`);
  }
  if (r.client.name !== PLATFORM_FEEDBACK_CLIENT_NAME) fail('client.name', `must be ${PLATFORM_FEEDBACK_CLIENT_NAME}`);
  if (r.client.version.length < 1 || r.client.version.length > LIMITS.version || !VERSION_RE.test(r.client.version)) {
    fail('client.version', `must be 1 to ${LIMITS.version} characters of letters, digits, '.', '+' or '-'`);
  }
  const bounded: Array<[string, string | undefined, number]> = [
    ['agent', r.agent, LIMITS.agent],
    ['os', r.os, LIMITS.os],
    ['arch', r.arch, LIMITS.arch],
    ['command', r.command, LIMITS.command],
    ['docUrl', r.docUrl, LIMITS.docUrl],
    ['errorExcerpt', r.errorExcerpt, LIMITS.errorExcerpt],
    ['appSlug', r.appSlug, LIMITS.appSlug],
  ];
  for (const [field, value, max] of bounded) {
    if (value !== undefined && value.length > max) {
      fail(field, `must be at most ${max} characters after redaction, got ${value.length}`);
    }
  }
  if (r.docUrl !== undefined && !r.docUrl.startsWith(PLATFORM_FEEDBACK_DOC_URL_PREFIX)) {
    fail('docUrl', `must start with ${PLATFORM_FEEDBACK_DOC_URL_PREFIX} (after redaction)`);
  }
  if (r.exitCode !== undefined && (!Number.isInteger(r.exitCode) || r.exitCode < 0 || r.exitCode > 255)) {
    fail('exitCode', 'must be an integer 0 to 255');
  }
  if (r.httpStatus !== undefined && (!Number.isInteger(r.httpStatus) || r.httpStatus < 100 || r.httpStatus > 599)) {
    fail('httpStatus', 'must be an integer 100 to 599');
  }
  if (r.sdk !== undefined) {
    if (r.sdk.length > LIMITS.sdk) fail('sdk', `must hold at most ${LIMITS.sdk} entries`);
    r.sdk.forEach((s, i) => {
      if (s.name.length < 1 || s.name.length > LIMITS.sdkName) fail(`sdk[${i}].name`, `must be 1 to ${LIMITS.sdkName} characters`);
      if (s.version.length < 1 || s.version.length > LIMITS.version) {
        fail(`sdk[${i}].version`, `must be 1 to ${LIMITS.version} characters`);
      }
    });
  }
}

/**
 * The last check before a request exists: no string in it may contain a
 * credential value the redactor knows. It reads the DECODED values, so a
 * credential JSON would escape is still found. (The CLI's
 * feedbackRefuseIfTokenInBody.)
 */
export function refuseIfTokenInRequest(input: PlatformFeedbackCreateInput, tokens: string[]): void {
  if (tokens.length === 0) return;
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, e] of Object.entries(v)) {
        strings.push(k);
        walk(e);
      }
    }
  };
  walk(JSON.parse(JSON.stringify(input)));
  if (strings.some((s) => tokens.some((t) => s.includes(t)))) {
    throw new PlatformFeedbackInputError(
      'request',
      'still contains your API key after redaction; remove it from the field it is in'
    );
  }
}

/** Validates and de-duplicates refs for getStatus, keeping the caller's order. */
export function normalizeStatusRefs(refs: string[]): string[] {
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!STATUS_REF_RE.test(ref)) {
      throw new PlatformFeedbackInputError(
        'refs',
        `contains ${JSON.stringify(raw.slice(0, LIMITS.statusRef))}, which is not a feedback ref — use the ref send_platform_feedback returned, e.g. 5123-3f9a01bc`
      );
    }
    if (!out.includes(ref)) out.push(ref);
  }
  if (out.length < 1 || out.length > LIMITS.statusRefs) {
    throw new PlatformFeedbackInputError('refs', `must hold 1 to ${LIMITS.statusRefs} refs, got ${out.length}`);
  }
  return out;
}

/**
 * Builds the result rows from the refs that were ASKED for, in that order: a
 * ref the response omits is not found, and a row nobody asked about is dropped.
 */
export function alignStatusItems(refs: string[], got: unknown): PlatformFeedbackStatusItem[] {
  const byRef = new Map<string, PlatformFeedbackStatusItem>();
  if (Array.isArray(got)) {
    for (const item of got as PlatformFeedbackStatusItem[]) {
      if (item && typeof item.ref === 'string' && !byRef.has(item.ref)) byRef.set(item.ref, item);
    }
  }
  return refs.map((ref) => {
    const item = byRef.get(ref);
    if (!item || item.found !== true) return { ref, found: false as const };
    return {
      ref,
      found: true as const,
      status: item.status,
      fixedIn: item.fixedIn ?? null,
      note: item.note ?? null,
      reporters: item.reporters,
      firstSeenAt: item.firstSeenAt ?? null,
      updatedAt: item.updatedAt ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

export type PlatformFeedbackErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'missing_scope'
  | 'collection_off'
  | 'forbidden'
  | 'rate_limited'
  | 'not_offered'
  | 'rejected'
  | 'unavailable'
  | 'failed';

/** The server's token-scope refusal ("…does not have the required scope…"). Keyed on its stable core, as the CLI does. */
export const isInsufficientScopeMsg = (msg: string) => msg.toLowerCase().includes('required scope');
/** The server's collection-off refusal ("Feedback is not being collected here right now."). */
export const isCollectionOffMsg = (msg: string) => {
  const m = msg.toLowerCase();
  return m.includes('not being collected') || m.includes('not collecting');
};

/** At most this much of a server message is quoted back to the agent. */
const SERVER_MSG_MAX = 300;

function quoteServer(msg: string): string {
  const firstLine = msg.trim().split('\n')[0] ?? '';
  return firstLine.length > SERVER_MSG_MAX ? `${firstLine.slice(0, SERVER_MSG_MAX)}…` : firstLine;
}

/**
 * Maps a failure from either procedure to a message an agent can act on. A
 * tRPC error is never passed through raw: the server's own sentence is quoted
 * (first line, bounded) only where it carries information this mapping lacks.
 */
export function translatePlatformFeedbackError(
  err: unknown,
  webUrl: string
): { code: PlatformFeedbackErrorCode; message: string } {
  if (err instanceof PlatformFeedbackInputError) return { code: 'invalid_input', message: err.message };
  if (!(err instanceof TrpcError)) {
    return { code: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
  const msg = quoteServer(err.serverMessage ?? '');
  const said = msg ? ` Civitai said: "${msg}"` : '';
  switch (err.status) {
    case 401:
      return {
        code: 'unauthorized',
        message:
          'Civitai did not accept the API key for this request (401). Set a valid CIVITAI_API_KEY, or send ' +
          `Authorization: Bearer <key> with the MCP request. Keys are created at ${webUrl}/user/account.`,
      };
    case 403:
      if (isInsufficientScopeMsg(msg)) {
        return {
          code: 'missing_scope',
          message:
            "This API key's scope does not cover platform feedback (403): it needs the AppBlocksSubmit scope " +
            '("Manage your Apps"), an opt-in scope that a scoped key or token only has if it was granted ' +
            `explicitly. A full-access personal API key passes this check: create one at ${webUrl}/user/account. ` +
            'Or use a token that was ' +
            'granted AppBlocksSubmit — for example the one `civitai login` mints for the Civitai CLI — and set ' +
            'it as CIVITAI_API_KEY or send it as Authorization: Bearer <key>.',
        };
      }
      if (isCollectionOffMsg(msg)) {
        return {
          code: 'collection_off',
          message:
            'Civitai is not collecting platform feedback right now (403). That is the server\'s answer, not a ' +
            'problem with your key or your report — try again later.',
        };
      }
      return {
        code: 'forbidden',
        message: `Civitai refused this platform-feedback request (403), for a reason this server cannot name.${said}`,
      };
    case 429:
      return {
        code: 'rate_limited',
        message:
          'Rate limited by Civitai (429). Sending is limited to about 10 reports an hour and 40 a day per ' +
          'user, status checks to about 60 a minute. Wait before trying again.' + said,
      };
    case 404:
      return {
        code: 'not_offered',
        message: `This Civitai server does not offer platform feedback (404); nothing was recorded.${said}`,
      };
    case 400:
      return {
        code: 'rejected',
        message:
          'Civitai rejected the request (400) although it passed this server\'s own checks, so its message ' +
          `is all there is to go on.${said}`,
      };
    case 503:
      return { code: 'unavailable', message: `Platform feedback is unavailable right now (503); try again later.${said}` };
    default:
      return { code: 'failed', message: `The platform-feedback request failed (HTTP ${err.status}).${said}` };
  }
}

/** A tool error result carrying the translated message and a stable code. */
export function platformFeedbackFailure(err: unknown, webUrl: string): ToolResult {
  const { code, message } = translatePlatformFeedbackError(err, webUrl);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    structuredContent: { ok: false, code, error: message },
    isError: true,
  };
}
