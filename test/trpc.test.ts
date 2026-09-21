import { describe, it, expect, vi, afterEach } from 'vitest';
import { stringify as devalueStringify } from 'devalue';
import { parseTrpcError, unwrapTrpcResult, TrpcClient } from '../src/client/trpc.js';
import { AuthContext } from '../src/client/auth.js';
import { parseConfig } from '../src/config.js';

describe('parseTrpcError', () => {
  it('surfaces the inner message from error.json', () => {
    const body = JSON.stringify({ error: { json: { message: 'Not found' } } });
    const err = parseTrpcError('article.getById', 404, 'Not Found', body);
    expect(err.message).toBe('article.getById: Not found');
    expect(err.status).toBe(404);
  });

  it('surfaces zodError validation details', () => {
    const body = JSON.stringify({
      error: { json: { message: 'Bad input', data: { zodError: { fieldErrors: { title: ['Required'] } } } } },
    });
    const err = parseTrpcError('article.upsert', 400, 'Bad Request', body);
    expect(err.message).toContain('Bad input');
    expect(err.message).toContain('Validation errors');
    expect(err.message).toContain('Required');
    expect(err.zodError).toEqual({ fieldErrors: { title: ['Required'] } });
  });

  it('falls back to raw text when body is not JSON', () => {
    const err = parseTrpcError('x.y', 500, 'Server Error', 'boom');
    expect(err.message).toContain('x.y failed: 500 Server Error');
    expect(err.message).toContain('boom');
  });

  it('handles error without json wrapper', () => {
    const body = JSON.stringify({ error: { message: 'plain' } });
    const err = parseTrpcError('x.y', 400, 'Bad', body);
    expect(err.message).toBe('x.y: plain');
  });

  // Pins a DELIBERATE asymmetry: unwrapTrpcResult throws on a string it cannot
  // decode, this degrades quietly. Do not make the two consistent. A throw here
  // lands INSIDE the surrounding try, so the catch swallows it and appends 500
  // characters of the raw body to the message instead - the same exposure the
  // unrecognized-payload message was narrowed to avoid, on a 500 whose body is
  // an HTML error page. Passes on pre-fix code by design.
  it('does not throw on an error string it cannot decode', () => {
    const body = JSON.stringify({ error: 'not-devalue' });
    const err = parseTrpcError('x.y', 500, 'Server Error', body);
    expect(err.message).toBe('x.y failed: 500 Server Error');
    expect(err.status).toBe(500);
  });

  it('surfaces message and zodError from a devalue-encoded error', () => {
    const body = JSON.stringify({
      error: devalueStringify({
        message: 'Bad input',
        data: { zodError: { fieldErrors: { title: ['Required'] } } },
      }),
    });
    const err = parseTrpcError('article.upsert', 400, 'Bad Request', body);
    expect(err.message).toContain('article.upsert: Bad input');
    expect(err.message).toContain('Validation errors');
    expect(err.zodError).toEqual({ fieldErrors: { title: ['Required'] } });
  });
});

describe('unwrapTrpcResult', () => {
  it('unwraps result.data.json', () => {
    expect(unwrapTrpcResult({ result: { data: { json: { id: 5 } } } })).toEqual({ id: 5 });
  });

  it('unwraps result.data when no json key', () => {
    expect(unwrapTrpcResult({ result: { data: { id: 7 } } })).toEqual({ id: 7 });
  });

  it('returns the input when no result envelope', () => {
    expect(unwrapTrpcResult({ token: 'abc' })).toEqual({ token: 'abc' });
  });

  // The payloads below are produced by devalue.stringify rather than typed out,
  // so they are the same bytes the site's transformer writes for these values.
  it('decodes a devalue response body', () => {
    const data = devalueStringify({ id: 5, username: 'bob' });
    expect(typeof data).toBe('string');
    expect(unwrapTrpcResult({ result: { data } })).toEqual({ id: 5, username: 'bob' });
  });

  it('decodes a devalue payload whose value is undefined', () => {
    // devalue.stringify(undefined) is "-1" - a valid payload, not a decode failure.
    expect(unwrapTrpcResult({ result: { data: devalueStringify(undefined) } })).toBeUndefined();
  });

  it('decodes devalue types superjson dropped on this client', () => {
    const data = devalueStringify({ when: new Date('2026-01-02T03:04:05.000Z') });
    const out = unwrapTrpcResult({ result: { data } }) as { when: Date };
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('throws instead of returning a string it cannot decode', () => {
    expect(() => unwrapTrpcResult({ result: { data: 'not-devalue' } })).toThrow(
      /Unrecognized tRPC response payload/
    );
  });

  // The one response whose result.data IS a credential is user.getToken, and
  // this message is copied into the model's context and any MCP log. The first
  // assertion keeps it diagnostic (a JWT is still tellable from <!DOCTYP or
  // {"error"); the second is the one that fails if someone widens the slice
  // back for debuggability. Neither works without the other.
  it('describes an undecodable payload without quoting it', () => {
    const jwt = `header.${'x'.repeat(200)}.sig`;
    expect(() => unwrapTrpcResult({ result: { data: jwt } })).toThrow(/starting "header\.x/);
    expect(() => unwrapTrpcResult({ result: { data: jwt } })).not.toThrow(/x{20}/);
  });

  // A devalue pool falls back to superjson for a single non-POJO response, so
  // the format is per payload, not per pool. The `unwraps result.data.json`
  // case above IS that case; this one adds the part it does not cover, that
  // `meta` is discarded rather than revived. superjson is not a dependency
  // here, so the envelope is written out; the shape is the one the site's
  // union transformer documents.
  it('still unwraps a superjson envelope carrying meta', () => {
    const data = {
      json: { when: '2026-01-02T03:04:05.000Z' },
      meta: { values: { when: ['Date'] } },
    };
    expect(unwrapTrpcResult({ result: { data } })).toEqual({ when: '2026-01-02T03:04:05.000Z' });
  });
});

describe('TrpcClient (mocked fetch)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function client(): TrpcClient {
    const config = parseConfig({ CIVITAI_API_URL: 'https://example.test', CIVITAI_API_KEY: 'k' });
    return new TrpcClient(new AuthContext(config, undefined));
  }

  it('wraps input as { json } and includes meta.values, returning unwrapped data', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://example.test/api/trpc/article.upsert');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ json: { id: 1 }, meta: { values: { publishedAt: ['Date'] } } });
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
      return new Response(JSON.stringify({ result: { data: { json: { id: 1, status: 'Published' } } } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await client().call('article.upsert', { id: 1 }, 'POST', { publishedAt: ['Date'] });
    expect(res).toEqual({ id: 1, status: 'Published' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('encodes GET input in the query string', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('https://example.test/api/trpc/user.getById?input=');
      const decoded = decodeURIComponent(url.split('input=')[1]!);
      expect(JSON.parse(decoded)).toEqual({ json: { id: 42 } });
      return new Response(JSON.stringify({ result: { data: { json: { id: 42, username: 'bob' } } } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await client().lookupUser(42);
    expect(res).toEqual({ id: 42, username: 'bob' });
  });

  it('sends json:null for a no-argument procedure on GET', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // Not `{}`: JSON.stringify({ json: undefined }) drops the key, and Civitai's
      // tRPC rejects an input without `json` as "Invalid input".
      const decoded = decodeURIComponent(url.split('input=')[1]!);
      expect(JSON.parse(decoded)).toEqual({ json: null });
      return new Response(JSON.stringify({ result: { data: { json: { unread: 0 } } } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().call('user.checkNotifications', undefined, 'GET')).resolves.toEqual({
      unread: 0,
    });
  });

  it('sends json:null for a no-argument procedure on POST', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ json: null });
      return new Response(JSON.stringify({ result: { data: { json: { ok: true } } } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().call('chat.markAllAsRead', undefined)).resolves.toEqual({ ok: true });
  });

  it('throws a TrpcError carrying zodError from a DEVALUE error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: devalueStringify({ message: 'nope', data: { zodError: { x: 1 } } }),
            }),
            { status: 400 }
          )
      )
    );
    await expect(client().call('x.y', {})).rejects.toMatchObject({
      status: 400,
      zodError: { x: 1 },
    });
    await expect(client().call('x.y', {})).rejects.toThrow(/x\.y: nope/);
  });

  it('throws a TrpcError carrying zodError on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { json: { message: 'nope', data: { zodError: { x: 1 } } } } }), {
            status: 400,
          })
      )
    );
    await expect(client().call('x.y', {})).rejects.toMatchObject({
      status: 400,
      zodError: { x: 1 },
    });
  });

  it('resolves self user id by decoding the JWT from user.getToken', async () => {
    const payload = Buffer.from(JSON.stringify({ userId: 999 })).toString('base64url');
    const token = `header.${payload}.sig`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: { data: { json: { token } } } }), { status: 200 }))
    );
    const c = client();
    expect(await c.getSelfUserId()).toBe(999);
  });

  // The reported break: against a devalue-writing pool getSelfUserId threw
  // "user.getToken returned no token", which took every write tool down with it.
  it('resolves self user id from a devalue user.getToken response', async () => {
    const payload = Buffer.from(JSON.stringify({ userId: 999 })).toString('base64url');
    const token = `header.${payload}.sig`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ result: { data: devalueStringify({ token }) } }), { status: 200 })
      )
    );
    expect(await client().getSelfUserId()).toBe(999);
  });
});
