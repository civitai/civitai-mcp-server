import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { parseConfig } from '../src/config.js';
// The pullable CLI is a standalone .mjs; it exports a pure parse helper we can
// unit-test without a network (and importing it must NOT trigger main()).
import {
  parseRpcResponse,
  postImageFlow,
  contentTypeForFile,
  defaultTitleFromFile,
} from '../scripts/mcp-cli.mjs';

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
// Unit: post-image helpers + the upload→create_post chaining.
// ---------------------------------------------------------------------------

describe('contentTypeForFile', () => {
  it('maps common image extensions', () => {
    expect(contentTypeForFile('step_0-0.png')).toBe('image/png');
    expect(contentTypeForFile('a.JPG')).toBe('image/jpeg');
    expect(contentTypeForFile('a.jpeg')).toBe('image/jpeg');
    expect(contentTypeForFile('a.webp')).toBe('image/webp');
    expect(contentTypeForFile('a.gif')).toBe('image/gif');
  });
  it('returns undefined for unknown extensions (server probes)', () => {
    expect(contentTypeForFile('a.bin')).toBeUndefined();
    expect(contentTypeForFile('noext')).toBeUndefined();
  });
});

describe('defaultTitleFromFile', () => {
  it('strips directories and extension', () => {
    expect(defaultTitleFromFile('out/step_0-0.png')).toBe('step_0-0');
    expect(defaultTitleFromFile('C:\\renders\\foo.jpeg')).toBe('foo');
    expect(defaultTitleFromFile('bare')).toBe('bare');
  });
});

describe('postImageFlow', () => {
  it('uploads base64 in the body, then creates a published post with the returned uuid', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const callToolImpl = async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'upload_image') {
        return {
          content: [{ type: 'text', text: 'uuid-abc\nUploaded image. UUID: uuid-abc (8x8)' }],
          structuredContent: { uuid: 'uuid-abc', width: 8, height: 8 },
        };
      }
      // create_post
      return {
        content: [{ type: 'text', text: 'Post created and published.\nID: 99\nURL: https://civitai.com/posts/99' }],
        structuredContent: { ok: true, id: 99, url: 'https://civitai.com/posts/99', published: true },
      };
    };

    const fileBytes = Buffer.from('PNGDATA');
    const { post, uuid } = await postImageFlow({
      mcpUrl: 'http://x/mcp',
      apiKey: 'k',
      fileBytes,
      fileName: 'step_0-0.png',
      title: 'My render',
      publish: true,
      callToolImpl,
    });

    // upload_image first, with base64 of the file in the BODY (not argv) + png content-type.
    expect(calls[0].name).toBe('upload_image');
    expect(calls[0].args.data).toBe(fileBytes.toString('base64'));
    expect(calls[0].args.contentType).toBe('image/png');

    // create_post second, attaching the returned uuid, published.
    expect(calls[1].name).toBe('create_post');
    expect(calls[1].args.images).toEqual([{ uuid: 'uuid-abc' }]);
    expect(calls[1].args.publish).toBe(true);
    expect(calls[1].args.title).toBe('My render');

    expect(uuid).toBe('uuid-abc');
    expect(post.structuredContent.url).toBe('https://civitai.com/posts/99');
  });

  it('falls back to the bare-UUID lead line when structuredContent is absent', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const callToolImpl = async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'upload_image') {
        return { content: [{ type: 'text', text: 'uuid-xyz\nUploaded image. UUID: uuid-xyz' }] };
      }
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { id: 1, url: 'u' } };
    };
    const { uuid } = await postImageFlow({
      mcpUrl: 'http://x/mcp',
      apiKey: 'k',
      fileBytes: Buffer.from('x'),
      fileName: 'a.png',
      publish: false,
      callToolImpl,
    });
    expect(uuid).toBe('uuid-xyz');
    expect(calls[1].args.publish).toBe(false);
  });

  it('throws when upload returns no uuid', async () => {
    const callToolImpl = async () => ({ content: [{ type: 'text', text: '' }] });
    await expect(
      postImageFlow({
        mcpUrl: 'http://x/mcp',
        apiKey: 'k',
        fileBytes: Buffer.from('x'),
        fileName: 'a.png',
        callToolImpl,
      })
    ).rejects.toThrow(/UUID/);
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
