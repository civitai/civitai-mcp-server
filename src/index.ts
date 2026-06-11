import { pathToFileURL } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Config } from './config.js';
import { getConfig } from './config.js';
import { buildToolAuthMap, createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import {
  isBrowserUserAgent,
  renderLandingHtml,
  renderLlmsTxt,
  resolveBaseUrl,
  type LandingData,
  type ToolAuth,
} from './lib/landing.js';
import { bearerFromHeader } from './client/auth.js';
import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  decideAuthChallenge,
  PROTECTED_RESOURCE_PATH,
} from './lib/oauth.js';

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

function baseUrlFromRequest(req: Request, override?: string): string {
  return resolveBaseUrl(
    {
      forwardedProto: headerValue(req.headers['x-forwarded-proto']),
      forwardedHost: headerValue(req.headers['x-forwarded-host']),
      host: headerValue(req.headers.host),
    },
    override
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Build the configured express app (without starting it). Exported so tests can
 * exercise the HTTP routes (well-known metadata, the OAuth 401 challenge) over a
 * real listener without network or a wrapper. Returns the tool count too so the
 * startup log can report it.
 */
export function createApp(config: Config): { app: express.Express; toolCount: number } {
  const { toolCount, catalog } = createServer(config);
  // Name -> auth requirement, consulted by POST /mcp to decide the OAuth 401.
  const toolAuth: Map<string, ToolAuth> = buildToolAuthMap(catalog);

  const landingData: LandingData = {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    catalog,
  };

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // RFC 9728 Protected Resource Metadata. Advertises the authorization server
  // (Civitai) and supported scopes so an MCP client that hit a 401 can discover
  // where to run the OAuth flow. `resource` is the called MCP endpoint and must
  // match exactly — in prod set PUBLIC_BASE_URL=https://mcp.civitai.com.
  app.get(PROTECTED_RESOURCE_PATH, (req: Request, res: Response) => {
    const baseUrl = baseUrlFromRequest(req, config.publicBaseUrl);
    res.status(200).json(buildProtectedResourceMetadata(baseUrl, config.apiUrl));
  });

  // Plain liveness/readiness probe — never touches upstream.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, tools: toolCount });
  });

  // llms.txt (llms.txt standard): always the agent-facing self-setup guide.
  app.get('/llms.txt', (req: Request, res: Response) => {
    res
      .type('text/plain; charset=utf-8')
      .send(renderLlmsTxt(landingData, baseUrlFromRequest(req, config.publicBaseUrl)));
  });

  // Dual-audience index. Content-negotiate on User-Agent:
  //   - browser UA           -> polished HTML landing page
  //   - non-browser / no UA  -> llms.txt as text/plain (agents self-configure)
  // MCP Streamable HTTP clients use POST /mcp (and may GET it with an SSE Accept
  // header); a plain browser/agent GET on "/" never collides with that.
  app.get('/', (req: Request, res: Response) => {
    const baseUrl = baseUrlFromRequest(req, config.publicBaseUrl);
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
    // OAuth trigger: before handing to the transport, short-circuit any
    // `tools/call` for an auth-`required` tool when no Authorization: Bearer is
    // present. MCP clients only start the OAuth flow on a real HTTP 401 +
    // WWW-Authenticate at this layer; a deeper JSON-RPC error (200 + isError) is
    // invisible to them. The body is already parsed by express.json above.
    // Presence-only check — an invalid/expired token still passes here and fails
    // upstream when the tool calls Civitai. Batch rule: if ANY call in a batch is
    // `required` and no bearer is present, the whole request is challenged.
    const hasBearer = bearerFromHeader(req.headers.authorization) !== undefined;
    const decision = decideAuthChallenge(req.body, hasBearer, toolAuth);
    if (decision.challenge) {
      const baseUrl = baseUrlFromRequest(req, config.publicBaseUrl);
      res
        .status(401)
        .set('WWW-Authenticate', buildWwwAuthenticate(baseUrl))
        .json({
          jsonrpc: '2.0',
          id: decision.id,
          error: { code: -32001, message: 'Authentication required' },
        });
      return;
    }

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

  return { app, toolCount };
}

async function startHttp(): Promise<void> {
  const config = getConfig();
  const { app, toolCount } = createApp(config);

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

// Only auto-start when run as the entry point (node dist/index.js), not when
// imported (e.g. tests importing `createApp`), so importing this module never
// binds a port or registers signal handlers as a side effect.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
