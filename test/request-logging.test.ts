import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { AuthContext } from '../src/client/auth.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = 'test-api-key-MUST-NOT-BE-LOGGED';

async function connect(env: Record<string, string>) {
  const { server } = createServer(parseConfig(env));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'log-test', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return lines;
}

describe('request logging', () => {
  it('logs the tool call and the refused fetch without secrets, URLs or arguments', async () => {
    const client = await connect({
      MCP_TRANSPORT: 'stdio',
      CIVITAI_API_KEY: API_KEY,
      CIVITAI_USER_ID: '4242',
    });
    const lines = captureStderr();
    const result = await client.callTool({
      name: 'upload_image',
      arguments: { url: 'http://[::ffff:a00:1]/img.png?token=QUERYSECRET' },
    });
    expect(result.isError).toBe(true);

    const events = lines.map((l) => JSON.parse(l)).map(({ ts: _ts, durationMs, ...rest }) => {
      if (rest.event === 'tool_call') expect(typeof durationMs).toBe('number');
      return rest;
    });
    expect(events).toEqual([
      {
        event: 'outbound_fetch',
        decision: 'refused',
        reason: 'address:ipv4-mapped:private',
        host: '::ffff:a00:1',
        hop: 0,
      },
      {
        event: 'tool_call',
        tool: 'upload_image',
        outcome: 'error',
        errorType: 'SsrfError',
        authenticated: true,
        // CIVITAI_USER_ID is config, not resolved from the caller's key: not logged.
      },
    ]);
    const all = lines.join('');
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain('QUERYSECRET');
    expect(all).not.toContain('img.png');
    await client.close();
  });

  it('logs the user id once it has been resolved from the caller key', async () => {
    const client = await connect({ MCP_TRANSPORT: 'stdio', CIVITAI_API_KEY: API_KEY });
    vi.spyOn(AuthContext.prototype, 'getResolvedSelfId').mockReturnValue(7071);
    const lines = captureStderr();
    await client.callTool({ name: 'upload_image', arguments: { url: 'http://127.0.0.1/' } });
    const call = lines.map((l) => JSON.parse(l)).find((e) => e.event === 'tool_call');
    expect(call).toMatchObject({ tool: 'upload_image', authenticated: true, userId: 7071 });
    await client.close();
  });

  it('does not attribute a call that fell back to the deployment key', async () => {
    // HTTP transport with no caller bearer: the env key is the deployment's,
    // so neither authenticated nor a user id may be claimed.
    const client = await connect({ CIVITAI_API_KEY: API_KEY, CIVITAI_USER_ID: '4242' });
    const lines = captureStderr();
    await client.callTool({ name: 'upload_image', arguments: { url: 'http://127.0.0.1/' } });
    const call = lines.map((l) => JSON.parse(l)).find((e) => e.event === 'tool_call');
    expect(call).toMatchObject({ tool: 'upload_image', outcome: 'error', authenticated: false });
    expect(call).not.toHaveProperty('userId');
    await client.close();
  });
});
