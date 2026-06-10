import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './config.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import {
  isBrowserUserAgent,
  renderLandingHtml,
  renderLlmsTxt,
  resolveBaseUrl,
  type LandingData,
} from './lib/landing.js';

async function startStdio(): Promise<void> {
  const config = getConfig();
  const { server, toolCount } = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel in stdio mode; log to stderr only.
  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} (stdio) ready — ${toolCount} tools\n`);

  // Graceful shutdown: close the transport cleanly so the parent (MCP client)
  // sees a clean EOF rather than a severed pipe.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`${SERVER_NAME}: ${signal} received, closing stdio transport\n`);
    void transport.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function baseUrlFromRequest(req: Request): string {
  return resolveBaseUrl({
    forwardedProto: headerValue(req.headers['x-forwarded-proto']),
    forwardedHost: headerValue(req.headers['x-forwarded-host']),
    host: headerValue(req.headers.host),
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function startHttp(): Promise<void> {
  const config = getConfig();
  const { toolCount, catalog } = createServer(config);

  const landingData: LandingData = {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    catalog,
  };

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Plain liveness/readiness probe — never touches upstream.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, tools: toolCount });
  });

  // llms.txt (llms.txt standard): always the agent-facing self-setup guide.
  app.get('/llms.txt', (req: Request, res: Response) => {
    res.type('text/plain; charset=utf-8').send(renderLlmsTxt(landingData, baseUrlFromRequest(req)));
  });

  // Dual-audience index. Content-negotiate on User-Agent:
  //   - browser UA           -> polished HTML landing page
  //   - non-browser / no UA  -> llms.txt as text/plain (agents self-configure)
  // MCP Streamable HTTP clients use POST /mcp (and may GET it with an SSE Accept
  // header); a plain browser/agent GET on "/" never collides with that.
  app.get('/', (req: Request, res: Response) => {
    const baseUrl = baseUrlFromRequest(req);
    if (isBrowserUserAgent(headerValue(req.headers['user-agent']))) {
      res.type('text/html; charset=utf-8').send(renderLandingHtml(landingData, baseUrl));
    } else {
      res.type('text/plain; charset=utf-8').send(renderLlmsTxt(landingData, baseUrl));
    }
  });

  // MCP Streamable HTTP endpoint. Stateless: a fresh server + transport per
  // request so the deployment scales horizontally and each request carries its
  // own Authorization header for upstream auth.
  // DNS-rebinding protection: when MCP_ALLOWED_HOSTS is configured, the transport
  // validates the incoming Host header against the allowlist (defends against a
  // malicious page resolving an attacker domain to this in-cluster IP). Left OFF
  // by default — the server normally sits behind an in-cluster ingress, and
  // leaving it on without the right Host entries would reject every request.
  // When enabled we always fold in localhost:PORT + 127.0.0.1:PORT so the README
  // .mcp.json localhost/inspector flow keeps working.
  const dnsRebindingProtection =
    config.mcpAllowedHosts && config.mcpAllowedHosts.length > 0
      ? {
          enableDnsRebindingProtection: true,
          allowedHosts: Array.from(
            new Set([
              ...config.mcpAllowedHosts,
              `localhost:${config.port}`,
              `127.0.0.1:${config.port}`,
            ])
          ),
        }
      : {};

  app.post('/mcp', async (req: Request, res: Response) => {
    const { server } = createServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...dnsRebindingProtection,
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

  // Body-parser errors (malformed JSON) must surface as a JSON-RPC parse error,
  // not express's default HTML error page. Express identifies the JSON middleware
  // as the source via `err.type === 'entity.parse.failed'` (a SyntaxError).
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    const isParseError =
      err instanceof SyntaxError &&
      (err as SyntaxError & { type?: string; status?: number }).type === 'entity.parse.failed';
    if (isParseError) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32700, message: `Parse error: ${err.message}` },
        id: null,
      });
      return;
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
      id: null,
    });
  });

  const httpServer = app.listen(config.port, () => {
    process.stdout.write(
      `${SERVER_NAME} v${SERVER_VERSION} (http) listening on :${config.port} — ${toolCount} tools — upstream ${config.apiUrl}\n`
    );
  });

  // Graceful shutdown: stop accepting new connections, drain in-flight requests
  // (up to ~10s), then force-exit so a hung connection can't block the pod.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`${SERVER_NAME}: ${signal} received, draining HTTP server\n`);
    const forceExit = setTimeout(() => {
      process.stderr.write(`${SERVER_NAME}: drain timed out, forcing exit\n`);
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    httpServer.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
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
