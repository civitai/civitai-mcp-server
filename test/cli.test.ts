import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { parseConfig } from '../src/config.js';
// The pullable CLI is a standalone .mjs; it exports a pure parse helper we can
// unit-test without a network (and importing it must NOT trigger main()).
import { parseRpcResponse } from '../scripts/mcp-cli.mjs';

// ---------------------------------------------------------------------------
// Unit: response parser handles both JSON and SSE (text/event-stream) shapes.
// ---------------------------------------------------------------------------

describe('parseRpcResponse', () => {
  it('parses a plain application/json body', () => {
    const env = parseRpcResponse('application/json', '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(env.result.ok).toBe(true);
  });

  it('parses a text/event-stream body (single data: line)', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"n":42}}\n\n';
    const env = parseRpcResponse('text/event-stream', body);
    expect(env.result.n).toBe(42);
  });

  it('uses the LAST data: event when several are present', () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"step":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"step":2}}\n\n';
    const env = parseRpcResponse('text/event-stream', body);
    expect(env.result.step).toBe(2);
  });

  it('joins multi-line data: payloads per the SSE spec', () => {
    const body = 'data: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"ok":true}}\n\n';
    const env = parseRpcResponse('text/event-stream', body);
    expect(env.result.ok).toBe(true);
  });

  it('throws on an event-stream with no data: payload', () => {
    expect(() => parseRpcResponse('text/event-stream', 'event: ping\n\n')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: GET /cli serves the script with the request host substituted.
// ---------------------------------------------------------------------------

describe('GET /cli', () => {
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

  it('returns 200 as application/javascript with the CLI marker', async () => {
    const res = await fetch(`${base}/cli`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('content-disposition')).toContain('mcp-cli.mjs');
    const body = await res.text();
    expect(body).toContain('Civitai MCP CLI');
    expect(body).toContain('parseRpcResponse');
  });

  it('substitutes __MCP_URL__ with the request-derived /mcp endpoint', async () => {
    const res = await fetch(`${base}/cli`);
    const body = await res.text();
    const { port } = server.address() as AddressInfo;
    // The placeholder is gone and the resolved endpoint is baked in.
    expect(body).not.toContain('__MCP_URL__');
    expect(body).toContain(`http://127.0.0.1:${port}/mcp`);
  });

  it('honors X-Forwarded-Proto / -Host so a pulled copy points at the public host', async () => {
    const res = await fetch(`${base}/cli`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mcp.civitai.com' },
    });
    const body = await res.text();
    expect(body).toContain('https://mcp.civitai.com/mcp');
  });
});
