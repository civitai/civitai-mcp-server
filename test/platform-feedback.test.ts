import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { platformFeedbackTools } from '../src/tools/platform-feedback.js';
import { SERVER_VERSION } from '../src/version.js';
import { CLIENT_VERSION_RE, LIMITS, dedupeStatusRefs } from '../src/lib/platform-feedback.js';

/**
 * send_platform_feedback / get_platform_feedback_status against a FAKE SERVER:
 * global fetch is stubbed, so these tests see the exact URL, method, headers
 * and body the real tRPC client produces — not a mocked `trpc.call`.
 */

type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

function collect(): Map<string, { schema: ZodRawShape; handler: Handler }> {
  const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
  const reg = ((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
    tools.set(name, { schema: config.inputSchema ?? {}, handler });
  }) as unknown as never;
  platformFeedbackTools(reg);
  return tools;
}

const API_KEY = 'c1v1tai4f6b8d0a2c4e6f8091a2b3c4d5';
const PKG_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^﻿/, '')) as {
    version: string;
  }
).version;

const services = (env: Record<string, string> = {}) =>
  buildServices(
    parseConfig({ CIVITAI_API_URL: 'https://api.fake.test', CIVITAI_API_KEY: API_KEY, MCP_TRANSPORT: 'http', ...env })
  );

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fake Civitai: records every request and answers with `reply`. */
function fakeServer(reply: (seen: Seen) => { status: number; body: unknown }): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const s: Seen = {
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : String(init.body),
      };
      seen.push(s);
      const { status, body } = reply(s);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    })
  );
  return seen;
}

const trpcOk = (json: unknown) => ({ status: 200, body: { result: { data: { json } } } });
const trpcErr = (status: number, message: string) => ({ status, body: { error: { json: { message, code: -32603 } } } });

const CREATED = { ref: '5123-3f9a01bc', duplicate: false, status: 'received', fixedIn: null, note: null, reporters: 1, reports: 1 };

async function send(args: Record<string, unknown>, svc = services()) {
  const { schema, handler } = collect().get('send_platform_feedback')!;
  return handler(z.object(schema).parse(args) as Record<string, unknown>, svc);
}

async function status(args: Record<string, unknown>, svc = services()) {
  const { schema, handler } = collect().get('get_platform_feedback_status')!;
  return handler(z.object(schema).parse(args) as Record<string, unknown>, svc);
}

afterEach(() => vi.restoreAllMocks());

describe('send_platform_feedback wire shape', () => {
  it('POSTs the literal tRPC payload, as given, with client=civitai-mcp and this server version', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    const res = await send({
      message: 'civitai app submit hung after the upload step',
      about: 'cli',
      ref: 'submit.server-refused',
      command: 'civitai app submit --dir ./apps/demo',
      httpStatus: 500,
      exitCode: 1,
      errorExcerpt: 'POST https://civitai.com/api/x?attempt=2 -> 500',
      docUrl: 'https://developer.civitai.com/apps/submit#flags',
      appSlug: 'demo',
      agent: 'claude-code',
      os: 'linux',
      arch: 'arm64',
      sdk: [{ name: '@civitai/app-sdk', version: '0.69.0' }],
    });
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.fake.test/api/trpc/platformFeedback.create');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    // Sent as given: no client-side redaction (by decision), so the query and
    // fragment the agent wrote are in the request.
    expect(seen[0]!.body).toBe(
      '{"json":{"message":"civitai app submit hung after the upload step",' +
        '"report":{"about":"cli","kind":"bug","client":{"name":"civitai-mcp","version":"' + PKG_VERSION + '"},' +
        '"ref":"submit.server-refused","agent":"claude-code","os":"linux","arch":"arm64",' +
        '"command":"civitai app submit --dir ./apps/demo","exitCode":1,"httpStatus":500,' +
        '"sdk":[{"name":"@civitai/app-sdk","version":"0.69.0"}],' +
        '"docUrl":"https://developer.civitai.com/apps/submit#flags",' +
        '"errorExcerpt":"POST https://civitai.com/api/x?attempt=2 -> 500","appSlug":"demo"}}}'
    );
    expect(res.structuredContent).toEqual({
      ref: '5123-3f9a01bc',
      duplicate: false,
      status: 'received',
      fixedIn: null,
      note: null,
      reporters: 1,
      excerptClipped: false,
      hint: 'Pass ref to get_platform_feedback_status to read its status later.',
    });
    expect(res.content[0]!.text).toContain('call get_platform_feedback_status with refs: ["5123-3f9a01bc"]');
  });
  it('omits every unset optional field (never a zero value) and defaults kind to bug', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    await send({ message: 'the review page never loads', about: 'review' });
    expect(seen[0]!.body).toBe(
      `{"json":{"message":"the review page never loads","report":{"about":"review","kind":"bug","client":{"name":"civitai-mcp","version":"${PKG_VERSION}"}}}}`
    );
  });

  it("the version it reports is package.json's and fits the server's pattern (invariant guard: true today)", () => {
    expect(SERVER_VERSION).toBe(PKG_VERSION);
    expect(SERVER_VERSION).toMatch(CLIENT_VERSION_RE);
    expect(SERVER_VERSION.length).toBeLessThanOrEqual(LIMITS.version);
  });
  it('renders a duplicate with its fix and Civitai\'s note quoted as data', async () => {
    fakeServer(() =>
      trpcOk({ ...CREATED, duplicate: true, status: 'fixed', fixedIn: { component: 'cli', version: '0.9.1' }, note: 'Upgrade the CLI.', reporters: 4, reports: 9 })
    );
    const res = await send({ message: 'submit hangs', about: 'cli' });
    expect(res.content[0]!.text).toBe(
      'Civitai already had this report; yours was counted on it. Ref: 5123-3f9a01bc\n' +
        'Status: fixed (4 reporters) — fixed in cli 0.9.1\n' +
        'Civitai\'s note: "Upgrade the CLI."\n' +
        'To check on it later, call get_platform_feedback_status with refs: ["5123-3f9a01bc"].'
    );
  });

  it('a null result is an error, never "Sent. Ref: undefined"', async () => {
    fakeServer(() => trpcOk(null));
    const res = await send({ message: 'submit hangs', about: 'cli' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not confirmed');
    expect(res.content[0]!.text).not.toContain('Ref: undefined');
  });
});

describe('what the zod schema cannot see', () => {
  it('cuts the error excerpt to the server\'s 500 characters, and says so', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    const res = await send({ message: 'm', about: 'cli', errorExcerpt: 'e'.repeat(600) });
    expect((JSON.parse(seen[0]!.body!).json.report.errorExcerpt as string)).toBe('e'.repeat(500));
    expect(res.structuredContent!.excerptClipped).toBe(true);
    expect(res.content[0]!.text).toContain('cut to its first 500 characters');
  });

  it('control: an excerpt of exactly 500 is sent whole and not reported as cut', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    const res = await send({ message: 'm', about: 'cli', errorExcerpt: 'e'.repeat(500) });
    expect((JSON.parse(seen[0]!.body!).json.report.errorExcerpt as string).length).toBe(500);
    expect(res.structuredContent!.excerptClipped).toBe(false);
  });

  it('never cuts an excerpt between the halves of a surrogate pair', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    // 499 units then an astral character: a naive slice(0, 500) ends on a lone high surrogate.
    await send({ message: 'm', about: 'cli', errorExcerpt: `${'e'.repeat(499)}\u{1F600}tail` });
    expect(JSON.parse(seen[0]!.body!).json.report.errorExcerpt).toBe('e'.repeat(499));
  });

  it('removes a NUL and repairs an unpaired surrogate, in the message and in report fields', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    await send({ message: 'bad\u0000 \uD800 text', about: 'other', command: 'run\u0000 \uDC00x' });
    const json = JSON.parse(seen[0]!.body!).json;
    expect(json.message).toBe('bad \uFFFD text');
    expect(json.report.command).toBe('run \uFFFDx');
  });

  it('refuses, without sending, a message that is blank once trimmed', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    const res = await send({ message: '   \n ', about: 'other' });
    expect(seen).toHaveLength(0);
    expect(res.structuredContent).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(res.content[0]!.text).toBe('Error: message is blank — nothing was sent');
  });
});

describe('error translation', () => {
  const cases: Array<{ name: string; status: number; msg: string; code: string; includes: string[] }> = [
    { name: 'missing scope', status: 403, msg: 'Your API key does not have the required scope for this action', code: 'missing_scope', includes: ['AppBlocksSubmit', 'full-access personal API key', 'https://civitai.com/user/account', 'CIVITAI_API_KEY'] },
    { name: 'collection off', status: 403, msg: 'Feedback is not being collected here right now.', code: 'collection_off', includes: ['not collecting platform feedback right now', 'try again later'] },
    { name: 'some other 403', status: 403, msg: 'You cannot do that', code: 'forbidden', includes: ['Civitai said: "You cannot do that"'] },
    { name: 'rate limit', status: 429, msg: 'You have sent a lot of platform feedback. Try again later.', code: 'rate_limited', includes: ['Rate limited', 'Wait before trying again'] },
    { name: 'unauthorized', status: 401, msg: 'UNAUTHORIZED', code: 'unauthorized', includes: ['did not accept the API key'] },
    { name: 'procedure missing', status: 404, msg: 'No "query"-procedure on path "platformFeedback.create"', code: 'not_offered', includes: ['does not offer platform feedback'] },
    { name: 'schema refusal', status: 400, msg: 'Invalid input', code: 'rejected', includes: ['rejected the request (400)', 'Civitai said: "Invalid input"'] },
    { name: 'unavailable', status: 503, msg: 'down', code: 'unavailable', includes: ['unavailable right now'] },
    { name: 'anything else', status: 500, msg: 'boom', code: 'failed', includes: ['HTTP 500'] },
  ];
  for (const tc of cases) {
    it(`send: ${tc.name}`, async () => {
      fakeServer(() => trpcErr(tc.status, tc.msg));
      const res = await send({ message: 'm', about: 'cli' });
      expect(res.isError).toBe(true);
      expect(res.structuredContent!.code).toBe(tc.code);
      const text = res.content[0]!.text;
      for (const s of tc.includes) expect(text).toContain(s);
      // Never the raw tRPC error: no procedure-prefixed message, no JSON envelope.
      expect(text).not.toContain('platformFeedback.create:');
      expect(text).not.toContain('-32603');
    });
  }

  it('status: collection off reads the same as on send', async () => {
    fakeServer(() => trpcErr(403, 'Feedback is not being collected here right now.'));
    const res = await status({ refs: ['5123-3f9a01bc'] });
    expect(res.structuredContent!.code).toBe('collection_off');
  });

  it('a devalue-encoded scope refusal is still recognised', async () => {
    const { stringify } = await import('devalue');
    fakeServer(() => ({ status: 403, body: { error: stringify({ message: 'Your API key does not have the required scope for this action' }) } }));
    const res = await send({ message: 'm', about: 'cli' });
    expect(res.structuredContent!.code).toBe('missing_scope');
  });

  it('no API key: a clear refusal, nothing sent', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    const svc = buildServices(parseConfig({ CIVITAI_API_URL: 'https://api.fake.test' }));
    const res = await send({ message: 'm', about: 'cli' }, svc);
    expect(seen).toHaveLength(0);
    expect(res.content[0]!.text).toContain('No API key available');
  });
});

describe('get_platform_feedback_status', () => {
  it('GETs the literal tRPC input and returns rows in the order asked, unknown ones not found', async () => {
    const seen = fakeServer(() =>
      trpcOk([
        // Out of order, plus a row nobody asked about, and one ref missing entirely.
        { ref: '9-aaaaaaaa', found: false },
        { ref: '7777-0123abcd', found: true, status: 'acknowledged', fixedIn: null, note: null, reporters: 2, firstSeenAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
        { ref: '1-deadbeef', found: true, status: 'fixed', fixedIn: { component: 'mcp', version: '0.2.0' }, note: 'x', reporters: 1, firstSeenAt: null, updatedAt: null },
      ])
    );
    const res = await status({ refs: ['5123-3f9a01bc', '7777-0123abcd', '9-aaaaaaaa', '5123-3f9a01bc'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url).toBe(
      'https://api.fake.test/api/trpc/platformFeedback.getStatus?input=' +
        encodeURIComponent('{"json":{"refs":["5123-3f9a01bc","7777-0123abcd","9-aaaaaaaa"]}}')
    );
    expect(res.structuredContent).toEqual({
      items: [
        { ref: '5123-3f9a01bc', found: false },
        { ref: '7777-0123abcd', found: true, status: 'acknowledged', fixedIn: null, note: null, reporters: 2, firstSeenAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
        { ref: '9-aaaaaaaa', found: false },
      ],
    });
    expect(res.content[0]!.text).toBe(
      '5123-3f9a01bc: not found\n7777-0123abcd: acknowledged (2 reporters), updated 2026-10-02T00:00:00.000Z\n9-aaaaaaaa: not found'
    );
  });

  const ref = (i: number) => `${i + 1}-0123abcd`;
  it('bounds: 1 and 50 refs are accepted', async () => {
    for (const n of [1, 50]) {
      const refs = Array.from({ length: n }, (_, i) => ref(i));
      const seen = fakeServer(() => trpcOk(refs.map((r) => ({ ref: r, found: false }))));
      const res = await status({ refs });
      expect(res.isError ?? false).toBe(false);
      expect(JSON.parse(decodeURIComponent(seen[0]!.url.split('input=')[1]!)).json.refs).toHaveLength(n);
    }
  });

  it('bounds: 0 and 51 refs, an over-long ref and a malformed ref are refused by the schema', () => {
    const { schema } = collect().get('get_platform_feedback_status')!;
    const parse = (refs: unknown) => z.object(schema).safeParse({ refs }).success;
    expect(parse([])).toBe(false);
    expect(parse(Array.from({ length: 51 }, (_, i) => ref(i)))).toBe(false);
    expect(parse([`1-${'a'.repeat(79)}`])).toBe(false);
    expect(parse(['5123 3f9a01bc'])).toBe(false);
    expect(parse(['"; rm -rf /'])).toBe(false);
    // control: the edges themselves pass.
    expect(parse([`1${'a'.repeat(79)}`])).toBe(true);
    expect(parse(Array.from({ length: 50 }, (_, i) => ref(i)))).toBe(true);
  });

  it('de-duplicates refs, keeping the order they were asked in', () => {
    expect(dedupeStatusRefs(['2-0123abcd', '1-0123abcd', '2-0123abcd'])).toEqual(['2-0123abcd', '1-0123abcd']);
    expect(dedupeStatusRefs(Array.from({ length: 50 }, () => '5123-3f9a01bc'))).toEqual(['5123-3f9a01bc']);
  });
});
