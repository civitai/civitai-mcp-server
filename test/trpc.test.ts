import { describe, it, expect, vi, afterEach } from 'vitest';
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
});
