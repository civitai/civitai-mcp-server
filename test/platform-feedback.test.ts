import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { platformFeedbackTools } from '../src/tools/platform-feedback.js';
import { SERVER_VERSION } from '../src/version.js';
import {
  buildPlatformFeedbackInput,
  normalizeStatusRefs,
  refuseIfTokenInRequest,
  PlatformFeedbackInputError,
} from '../src/lib/platform-feedback.js';

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
  it('POSTs the literal tRPC payload, scrubbed, with client=civitai-mcp and this server version', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    const res = await send({
      message: `civitai app submit hung after printing my key ${API_KEY}`,
      about: 'cli',
      ref: 'submit.server-refused',
      command: 'civitai app submit --dir /home/okonkwo/apps/demo',
      httpStatus: 500,
      exitCode: 1,
      errorExcerpt: 'POST https://civitai.com/api/x?sig=Rk3Vt9Wm2Xq7Zb5Lc1 -> 500',
      docUrl: 'https://developer.civitai.com/apps/submit#flags',
      appSlug: 'demo',
      agent: 'claude-code',
    });
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.fake.test/api/trpc/platformFeedback.create');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(seen[0]!.body).toBe(
      '{"json":{"message":"civitai app submit hung after printing my key <token>",' +
        '"report":{"about":"cli","kind":"bug","client":{"name":"civitai-mcp","version":"' + PKG_VERSION + '"},' +
        '"ref":"submit.server-refused","agent":"claude-code",' +
        '"command":"civitai app submit --dir /home/<user>/apps/demo","exitCode":1,"httpStatus":500,' +
        '"docUrl":"https://developer.civitai.com/apps/submit",' +
        '"errorExcerpt":"POST https://civitai.com/api/x -> 500","appSlug":"demo"}}}'
    );
    expect(res.structuredContent).toEqual({
      ref: '5123-3f9a01bc',
      duplicate: false,
      status: 'received',
      fixedIn: null,
      note: null,
      reporters: 1,
      redactions: [
        { kind: 'token', count: 1 },
        { kind: 'url-query', count: 2 },
        { kind: 'user-path', count: 1 },
      ],
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

  it('the version it reports is package.json\'s (invariant guard: the two agree today)', () => {
    expect(SERVER_VERSION).toBe(PKG_VERSION);
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
});

describe('every agent-supplied free-text field is scrubbed', () => {
  // 🔴 A LEDGER: the string-valued inputs of send_platform_feedback, asserted
  // in full. A new string input fails this until it is added here — and the
  // case below then puts a secret in it and proves it is scrubbed.
  const STRING_FIELDS = ['message', 'ref', 'command', 'errorExcerpt', 'docUrl', 'appSlug', 'agent', 'os', 'arch', 'sdk[].name', 'sdk[].version'];

  it('the ledger matches the tool\'s input schema', () => {
    const { schema } = collect().get('send_platform_feedback')!;
    const found: string[] = [];
    const visit = (t: z.ZodTypeAny, path: string) => {
      const inner = t instanceof z.ZodOptional || t instanceof z.ZodDefault ? t._def.innerType : t;
      if (inner instanceof z.ZodString) found.push(path);
      else if (inner instanceof z.ZodArray) visit(inner.element, `${path}[]`);
      else if (inner instanceof z.ZodObject) for (const [k, v] of Object.entries(inner.shape)) visit(v as z.ZodTypeAny, `${path}.${k}`);
    };
    for (const [k, v] of Object.entries(schema)) visit(v as z.ZodTypeAny, k);
    expect(found.sort()).toEqual([...STRING_FIELDS].sort());
  });

  it('a secret in each string field is gone from the request', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    // One DISTINCT secret per string field. Long fields get a GitHub-token
    // shape; the 16/32-character fields get an e-mail address, the longest
    // redacted shape that fits. The API key is not used, so the exact-token
    // rule cannot be what removes them. (ref is covered by the refusal test
    // below: a changed site key is refused, not sent.)
    // 40 characters: `ghp_` + 36, the shortest GitHub-token shape, and the agent/sdk-name maximum.
    const gh = (n: number) => `ghp_${String(n).repeat(2)}Hn8Wq2Zr6Tb0Vx3Ly7Kc1Md5Pf9Sg2Uj`;
    const secrets = {
      message: gh(10), command: gh(11), errorExcerpt: gh(12), appSlug: gh(13), agent: gh(14), sdkName: gh(17),
      os: 'q@osmail.io', arch: 'r@archmail.io', sdkVersion: 's@sdkvermail.io', docUrl: 'Zq7S3cr3tDocUrlValue1',
    };
    const res = await send({
      message: `failed with ${secrets.message}`,
      about: 'sdk',
      command: `run ${secrets.command}`,
      errorExcerpt: `err ${secrets.errorExcerpt}`,
      appSlug: secrets.appSlug,
      agent: secrets.agent,
      os: secrets.os,
      arch: secrets.arch,
      docUrl: `https://developer.civitai.com/x?token=${secrets.docUrl}`,
      sdk: [{ name: secrets.sdkName, version: secrets.sdkVersion }],
    });
    expect(res.isError ?? false).toBe(false);
    expect(seen).toHaveLength(1);
    for (const [field, v] of Object.entries(secrets)) expect(seen[0]!.body, field).not.toContain(v);
    const json = JSON.parse(seen[0]!.body!).json as { message: string; report: Record<string, unknown> };
    expect(json.message).toBe('failed with <credential>');
    expect(json.report).toMatchObject({
      command: 'run <credential>',
      errorExcerpt: 'err <credential>',
      appSlug: '<credential>',
      agent: '<credential>',
      os: '<email>',
      arch: '<email>',
      docUrl: 'https://developer.civitai.com/x',
      sdk: [{ name: '<credential>', version: '<email>' }],
    });
  });

  it('the exact API key in the message is replaced, not just credential shapes', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    await send({ message: `key is ${API_KEY}.`, about: 'scopes' });
    expect(seen[0]!.body).not.toContain(API_KEY);
    expect(JSON.parse(seen[0]!.body!).json.message).toBe('key is <token>.');
  });

  it('cuts the error excerpt to 500 characters AFTER scrubbing, and says so', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    // 750 characters raw, 449 once each user name becomes <user>: not cut.
    const res = await send({ message: 'm', about: 'cli', errorExcerpt: '/home/abcdefghijklmnop/x '.repeat(30) });
    const excerpt = JSON.parse(seen[0]!.body!).json.report.errorExcerpt as string;
    expect(excerpt.length).toBeLessThanOrEqual(500);
    expect(excerpt).not.toContain('abcdefghijklmnop');
    expect(res.structuredContent!.excerptClipped).toBe(false);

    const seen2 = fakeServer(() => trpcOk(CREATED));
    const res2 = await send({ message: 'm', about: 'cli', errorExcerpt: 'e'.repeat(600) });
    expect((JSON.parse(seen2[0]!.body!).json.report.errorExcerpt as string).length).toBe(500);
    expect(res2.structuredContent!.excerptClipped).toBe(true);
  });

  it('refuses, without sending, a site-key ref that redaction changed', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    const res = await send({ message: 'm', about: 'cli', ref: API_KEY });
    expect(seen).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(res.structuredContent!.code).toBe('invalid_input');
    expect(String(res.structuredContent!.error)).toMatch(/^ref looks like it contains a credential/);
    expect(String(res.structuredContent!.error)).not.toContain(API_KEY);
  });

  it('refuses, without sending, a docUrl whose credential userinfo takes its prefix', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    const res = await send({ message: 'm', about: 'docs', docUrl: 'https://developer.civitai.com/x@y/p' });
    expect(seen).toHaveLength(0);
    expect(res.structuredContent).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(String(res.structuredContent!.error)).toContain('docUrl must start with https://developer.civitai.com/');
  });

  it('refuses, without sending, a message that grows past 2000 characters when redacted', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    // 1994 characters raw; each 'a@b.io' (6) becomes '<email>' (7), so 2279 redacted.
    const res = await send({ message: 'a@b.io '.repeat(285).trim(), about: 'other' });
    expect(seen).toHaveLength(0);
    expect(res.structuredContent).toMatchObject({ code: 'invalid_input' });
    expect(String(res.structuredContent!.error)).toMatch(/^message must be 1 to 2000 characters after redaction/);
  });

  it('removes a NUL and repairs an unpaired surrogate instead of sending text the server refuses', async () => {
    const seen = fakeServer(() => trpcOk(CREATED));
    await send({ message: 'bad\u0000 \uD800 text', about: 'other' });
    expect(JSON.parse(seen[0]!.body!).json.message).toBe('bad � text');
  });
});

describe('the API-key backstop (invariant guard: no current field reaches it un-redacted)', () => {
  it('refuses a request whose decoded strings still contain the key', () => {
    expect(() =>
      refuseIfTokenInRequest(
        { message: 'ok', report: { about: 'cli', kind: 'bug', client: { name: 'civitai-mcp', version: '1.0.0' }, appSlug: `x${API_KEY}` } },
        [API_KEY]
      )
    ).toThrow(PlatformFeedbackInputError);
  });
  it('control: passes a request without it', () => {
    expect(() =>
      refuseIfTokenInRequest({ message: 'ok', report: { about: 'cli', kind: 'bug', client: { name: 'civitai-mcp', version: '1.0.0' } } }, [API_KEY])
    ).not.toThrow();
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

  it('bounds hold behind the schema too: normalizeStatusRefs refuses 0, 51 and malformed', () => {
    expect(() => normalizeStatusRefs([])).toThrow(/1 to 50 refs, got 0/);
    expect(() => normalizeStatusRefs(Array.from({ length: 51 }, (_, i) => ref(i)))).toThrow(/1 to 50 refs, got 51/);
    expect(() => normalizeStatusRefs(['ok-1', 'bad ref'])).toThrow(/not a feedback ref/);
    // De-duplication counts AFTER collapsing: 60 copies of one ref is one ref.
    expect(normalizeStatusRefs(Array.from({ length: 60 }, () => '5123-3f9a01bc'))).toEqual(['5123-3f9a01bc']);
  });
});

describe('buildPlatformFeedbackInput', () => {
  it('home-path redaction applies only to the home it is given (stdio mode)', () => {
    const { input, redactions } = buildPlatformFeedbackInput(
      { message: 'in /srv/agent-home/work it failed', about: 'cli' },
      '0.2.0',
      { tokens: [API_KEY], home: '/srv/agent-home' }
    );
    expect(input.message).toBe('in ~/work it failed');
    expect(redactions).toEqual([{ kind: 'home-path', count: 1 }]);
  });
});
