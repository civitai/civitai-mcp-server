import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { servicesFromHeaders, fail, type Services, type ToolResult } from './tools/helpers.js';
import type { ToolAuth, ToolCatalogEntry } from './lib/landing.js';
import { logEvent } from './lib/log.js';

import { browseTools } from './tools/browse.js';
import { articleTools } from './tools/articles.js';
import { commentTools } from './tools/comments.js';
import { messagingTools } from './tools/messaging.js';
import { announcementTools } from './tools/announcements.js';
import { changelogTools } from './tools/changelog.js';
import { imageTools } from './tools/images.js';
import { whoamiTools } from './tools/whoami.js';
import { postTools } from './tools/posts.js';
import { engagementTools } from './tools/engagement.js';
import { collectionTools } from './tools/collections.js';
import { notificationTools } from './tools/notifications.js';
import { chatTools } from './tools/chat.js';
import { bountyTools } from './tools/bounties.js';
import { platformFeedbackTools } from './tools/platform-feedback.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export { SERVER_NAME, SERVER_VERSION };

interface ToolConfig<Shape extends ZodRawShape> {
  title?: string;
  description: string;
  inputSchema?: Shape;
  annotations?: ToolAnnotations;
  /**
   * Auth requirement. Drives the HTTP-layer OAuth 401 challenge in index.ts.
   * When omitted it defaults from the tool's category: Browse tools are
   * `public`, every other category `required`. The default is only a guess
   * from the category; it is not derived from the handler. A tool is `public`
   * only if its upstream calls succeed with no key: Civitai's REST `/api/v1`
   * does, its tRPC surface does not (an anonymous tRPC call gets 401 "Please
   * use the public API instead"), so a tRPC read such as `get_post` stays
   * `required` even though its handler never calls `requireKey()`. A tool
   * outside Browse that reaches REST alone must set `auth: 'public'` itself, or
   * the HTTP layer would challenge a call that would have succeeded. Tagging a tool
   * `required` lets the HTTP layer challenge BEFORE the JSON-RPC layer, so MCP
   * clients see a real 401 + WWW-Authenticate and can start the OAuth flow.
   */
  auth?: ToolAuth;
}

/** The single category whose tools run anonymously (no bearer required). */
const PUBLIC_CATEGORY = 'Browse (no auth required)';

/** Registrar passed to each tool module: `reg(name, config, handler)`. */
export type Registrar = <Shape extends ZodRawShape>(
  name: string,
  config: ToolConfig<Shape>,
  handlerFn: (args: z.objectOutputType<Shape, z.ZodTypeAny>, services: Services) => Promise<ToolResult>
) => void;

export type ToolModule = (reg: Registrar) => void;

/** Count of tools registered, exported for tests/smoke checks. */
export interface BuiltServer {
  server: McpServer;
  toolCount: number;
  /** Single source of truth for the landing page + llms.txt tool catalog. */
  catalog: ToolCatalogEntry[];
}

/**
 * Build an McpServer with all tools registered. The provided `config` is the
 * static env config; per-request auth (Authorization header) is resolved inside
 * each tool call from the MCP request's headers, falling back to the env key.
 */
export function createServer(config: Config): BuiltServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  let toolCount = 0;
  const catalog: ToolCatalogEntry[] = [];
  // Set by the module loop below so each registration records its category.
  let currentCategory = 'Other';

  const reg: Registrar = (name, toolConfig, handlerFn) => {
    toolCount++;
    // Default from the category (see ToolConfig.auth); an explicit `auth` wins.
    const auth: ToolAuth =
      toolConfig.auth ?? (currentCategory === PUBLIC_CATEGORY ? 'public' : 'required');
    catalog.push({
      name,
      title: toolConfig.title,
      description: toolConfig.description,
      category: currentCategory,
      readOnly: toolConfig.annotations?.readOnlyHint === true,
      destructive: toolConfig.annotations?.destructiveHint === true,
      auth,
    });
    server.registerTool(
      name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: toolConfig.inputSchema ?? ({} as ZodRawShape),
        annotations: toolConfig.annotations,
      },
      (async (args: unknown, extra: RequestHandlerExtra<never, never>): Promise<ToolResult> => {
        // Resolve per-request auth from the HTTP request headers (if any).
        const headers = extra.requestInfo?.headers as
          | Record<string, string | string[] | undefined>
          | undefined;
        const services = servicesFromHeaders(config, headers);
        const started = performance.now();
        let outcome: 'ok' | 'error' = 'error';
        let errorType: string | undefined;
        try {
          const result = await handlerFn(args as Parameters<typeof handlerFn>[0], services);
          outcome = result.isError ? 'error' : 'ok';
          return result;
        } catch (err) {
          errorType = err instanceof Error ? err.name : typeof err;
          return fail(err);
        } finally {
          // One line per tool call. Only the tool name, outcome, timing, the
          // error class and the caller's numeric user id when already known —
          // never arguments, keys, URLs or messages (they can carry secrets).
          logEvent('tool_call', {
            tool: name,
            outcome,
            errorType,
            durationMs: Math.round(performance.now() - started),
            authenticated: services.auth.keyIsCaller,
            userId: services.auth.keyIsCaller ? services.auth.getCachedSelfId() : undefined,
          });
        }
      }) as Parameters<typeof server.registerTool>[2]
    );
  };

  const modules: Array<{ category: string; mod: ToolModule }> = [
    { category: 'Browse (no auth required)', mod: browseTools },
    { category: 'Posts', mod: postTools },
    { category: 'Engagement', mod: engagementTools },
    { category: 'Articles', mod: articleTools },
    { category: 'Comments', mod: commentTools },
    { category: 'Collections', mod: collectionTools },
    { category: 'Notifications', mod: notificationTools },
    { category: 'Messaging', mod: messagingTools },
    { category: 'Chat', mod: chatTools },
    { category: 'Bounties', mod: bountyTools },
    { category: 'Announcements (moderator)', mod: announcementTools },
    { category: 'Changelog (moderator)', mod: changelogTools },
    { category: 'Images', mod: imageTools },
    { category: 'Platform feedback', mod: platformFeedbackTools },
    { category: 'Utility', mod: whoamiTools },
  ];
  for (const { category, mod } of modules) {
    currentCategory = category;
    mod(reg);
  }

  return { server, toolCount, catalog };
}

/**
 * Build a name -> auth-requirement lookup from a tool catalog. The HTTP layer
 * (index.ts) consults this to decide whether an unauthenticated `tools/call`
 * should be short-circuited with an OAuth 401 challenge. Unknown tool names are
 * treated as `public` by callers (an unknown name is the transport's problem,
 * not an auth problem — let it produce a proper JSON-RPC method error).
 */
export function buildToolAuthMap(catalog: ToolCatalogEntry[]): Map<string, ToolAuth> {
  return new Map(catalog.map((t) => [t.name, t.auth]));
}
