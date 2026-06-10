import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './config.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function startStdio(): Promise<void> {
  const config = getConfig();
  const { server, toolCount } = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel in stdio mode; log to stderr only.
  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} (stdio) ready — ${toolCount} tools\n`);
}

async function startHttp(): Promise<void> {
  const config = getConfig();
  const { toolCount } = createServer(config);

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Plain liveness/readiness probe — never touches upstream.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, tools: toolCount });
  });

  // MCP Streamable HTTP endpoint. Stateless: a fresh server + transport per
  // request so the deployment scales horizontally and each request carries its
  // own Authorization header for upstream auth.
  app.post('/mcp', async (req: Request, res: Response) => {
    const { server } = createServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
          id: null,
        });
      }
    }
  });

  // GET/DELETE on /mcp are unsupported in stateless mode (no SSE stream / session).
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless server: use POST /mcp).' },
      id: null,
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.listen(config.port, () => {
    process.stdout.write(
      `${SERVER_NAME} v${SERVER_VERSION} (http) listening on :${config.port} — ${toolCount} tools — upstream ${config.apiUrl}\n`
    );
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  if (config.transport === 'stdio') {
    await startStdio();
  } else {
    await startHttp();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
