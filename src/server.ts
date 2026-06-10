import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { bearerFromHeader } from './client/auth.js';
import { buildServices, fail, type Services, type ToolResult } from './tools/helpers.js';

import { browseTools } from './tools/browse.js';
import { articleTools } from './tools/articles.js';
import { commentTools } from './tools/comments.js';
import { messagingTools } from './tools/messaging.js';
import { announcementTools } from './tools/announcements.js';
import { changelogTools } from './tools/changelog.js';
import { imageTools } from './tools/images.js';
import { whoamiTools } from './tools/whoami.js';

export const SERVER_NAME = 'civitai-mcp-server';
export const SERVER_VERSION = '0.1.0';

interface ToolConfig<Shape extends ZodRawShape> {
  title?: string;
  description: string;
  inputSchema?: Shape;
  annotations?: ToolAnnotations;
}

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
}

/**
 * Build an McpServer with all tools registered. The provided `config` is the
 * static env config; per-request auth (Authorization header) is resolved inside
 * each tool call from the MCP request's headers, falling back to the env key.
 */
export function createServer(config: Config): BuiltServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  let toolCount = 0;

  const reg: Registrar = (name, toolConfig, handlerFn) => {
    toolCount++;
    server.registerTool(
      name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: toolConfig.inputSchema ?? ({} as ZodRawShape),
        annotations: toolConfig.annotations,
      },
      (async (args: unknown, extra: RequestHandlerExtra<never, never>): Promise<ToolResult> => {
        // Resolve a per-request bearer from the HTTP request headers (if any).
        const headers = extra.requestInfo?.headers as
          | Record<string, string | string[] | undefined>
          | undefined;
        const requestKey = bearerFromHeader(headers?.authorization ?? headers?.Authorization);
        const services = buildServices(config, requestKey);
        try {
          return await handlerFn(args as Parameters<typeof handlerFn>[0], services);
        } catch (err) {
          return fail(err);
        }
      }) as Parameters<typeof server.registerTool>[2]
    );
  };

  for (const mod of [
    browseTools,
    articleTools,
    commentTools,
    messagingTools,
    announcementTools,
    changelogTools,
    imageTools,
    whoamiTools,
  ]) {
    mod(reg);
  }

  return { server, toolCount };
}
