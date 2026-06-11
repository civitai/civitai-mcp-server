import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { parseConfig } from '../src/config.js';
import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  decideAuthChallenge,
  PROTECTED_RESOURCE_PATH,
  SUPPORTED_SCOPES,
} from '../src/lib/oauth.js';
import { buildToolAuthMap, createServer } from '../src/server.js';

// ---------------------------------------------------------------------------
// Unit: pure metadata + challenge-decision helpers (no network).
// ---------------------------------------------------------------------------

describe('protected-resource metadata', () => {
  it('builds the RFC 9728 document with resource = <base>/mcp', () => {
    const meta = buildProtectedResourceMetadata('https://mcp.civitai.com', 'https://civitai.com');
    expect(meta.resource).toBe('https://mcp.civitai.com/mcp');
    expect(meta.resource.endsWith('/mcp')).toBe(true);
    expect(meta.authorization_servers).toEqual(['https://civitai.com']);
    expect(meta.bearer_methods_supported).toEqual(['header']);
    expect(meta.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
    // Sanity: canonical scope names present.
    expect(meta.scopes_supported).toContain('user:read');
    expect(meta.scopes_supported).toContain('models:write');
  });

  it('points WWW-Authenticate at the metadata document', () => {
    expect(buildWwwAuthenticate('https://mcp.civitai.com')).toBe(
      'Bearer resource_metadata="https://mcp.civitai.com/.well-known/oauth-protected-resource"'
    );
  });
});

describe('decideAuthChallenge', () => {
  const authMap = buildToolAuthMap(createServer(parseConfig({})).catalog);

  it('challenges a required tool call with no bearer', () => {
    const d = decideAuthChallenge(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_post' } },
      false,
      authMap
    );
    expect(d).toEqual({ challenge: true, id: 7 });
  });

  it('does not challenge a public tool call', () => {
    const d = decideAuthChallenge(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_models' } },
      false,
      authMap
    );
    expect(d.challenge).toBe(false);
  });

  it('does not challenge when a bearer is present', () => {
    const d = decideAuthChallenge(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_post' } },
      true,
      authMap
    );
    expect(d.challenge).toBe(false);
  });

  it('never challenges initialize / tools/list / notifications', () => {
    for (const method of ['initialize', 'tools/list', 'ping', 'notifications/initialized']) {
      expect(decideAuthChallenge({ jsonrpc: '2.0', id: 1, method }, false, authMap).challenge).toBe(
        false
      );
    }
  });

  it('challenges a batch if any call is required (echoes first offender id)', () => {
    const d = decideAuthChallenge(
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_models' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_post' } },
      ],
      false,
      authMap
    );
    expect(d).toEqual({ challenge: true, id: 2 });
  });

  it('treats unknown tool names as not-an-auth-problem', () => {
    const d = decideAuthChallenge(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_tool' } },
      false,
      authMap
    );
    expect(d.challenge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: real express app over an ephemeral port (no upstream network).
// ---------------------------------------------------------------------------

describe('HTTP routes', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { app } = createApp(parseConfig({}));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves protected-resource metadata with the right shape', async () => {
    const res = await fetch(`${base}${PROTECTED_RESOURCE_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.resource).toBe('string');
    expect((body.resource as string).endsWith('/mcp')).toBe(true);
    expect(body.authorization_servers).toEqual(['https://civitai.com']);
    expect(Array.isArray(body.scopes_supported)).toBe(true);
    expect((body.scopes_supported as string[]).length).toBeGreaterThan(0);
    expect(body.bearer_methods_supported).toEqual(['header']);
  });

  it('does NOT challenge a public tool call (passes to transport)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_models', arguments: { limit: 1 } },
      }),
    });
    // Not a 401 — the request reached the transport (which may error upstream,
    // but importantly it was NOT short-circuited with an auth challenge).
    expect(res.status).not.toBe(401);
  });

  it('challenges a required tool call with no Authorization (HTTP 401 + header)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'create_post', arguments: {} },
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${base}${PROTECTED_RESOURCE_PATH}"`
    );
    const body = (await res.json()) as { jsonrpc: string; id: unknown; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(42);
    expect(body.error.code).toBe(-32001);
  });

  it('does NOT challenge a required tool call WHEN Authorization is present', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer some-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'create_post', arguments: {} },
      }),
    });
    // Reaches the transport (token is not validated here); just not a 401.
    expect(res.status).not.toBe(401);
  });
});
