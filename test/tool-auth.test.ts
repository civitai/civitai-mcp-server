import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { createServer, type ToolModule } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { buildServices, fail, type Services, type ToolResult } from '../src/tools/helpers.js';
import { browseTools } from '../src/tools/browse.js';
import { postTools } from '../src/tools/posts.js';
import { engagementTools } from '../src/tools/engagement.js';
import { articleTools } from '../src/tools/articles.js';
import { commentTools } from '../src/tools/comments.js';
import { collectionTools } from '../src/tools/collections.js';
import { notificationTools } from '../src/tools/notifications.js';
import { messagingTools } from '../src/tools/messaging.js';
import { chatTools } from '../src/tools/chat.js';
import { bountyTools } from '../src/tools/bounties.js';
import { announcementTools } from '../src/tools/announcements.js';
import { changelogTools } from '../src/tools/changelog.js';
import { imageTools } from '../src/tools/images.js';
import { platformFeedbackTools } from '../src/tools/platform-feedback.js';
import { whoamiTools } from '../src/tools/whoami.js';

/**
 * The `auth` tag drives the HTTP-layer OAuth 401 challenge. `public` tells an
 * MCP client the tool works with no key, so a tool tagged `public` whose
 * upstream call needs a key is a false promise: the client skips OAuth and the
 * call fails upstream. Civitai answers an anonymous tRPC call with 401 "Please
 * use the public API instead" (measured 2026-11-14 on civitai.com and
 * civitai.red, `post.get` and `article.getById` included); REST `/api/v1/*`
 * answers 200. So only tools that reach REST alone, with no key, are public.
 */

// Ledger: every tool that runs anonymously. Fails when the set grows OR shrinks.
const PUBLIC_TOOLS = [
  'search_models',
  'get_model',
  'get_model_version',
  'search_images',
  'get_image',
  'search_creators',
  'list_enums',
];

describe('tool auth tags', () => {
  it('tags exactly the anonymous tools public', () => {
    const { catalog } = createServer(parseConfig({}));
    const publicTools = catalog.filter((t) => t.auth === 'public').map((t) => t.name);
    expect(publicTools.sort()).toEqual([...PUBLIC_TOOLS].sort());
  });
});

type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

const ALL_MODULES: ToolModule[] = [
  browseTools,
  postTools,
  engagementTools,
  articleTools,
  commentTools,
  collectionTools,
  notificationTools,
  messagingTools,
  chatTools,
  bountyTools,
  announcementTools,
  changelogTools,
  imageTools,
  platformFeedbackTools,
  whoamiTools,
];

function captureAll(): Map<string, { schema: ZodRawShape; handler: Handler }> {
  const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
  for (const mod of ALL_MODULES) {
    mod(((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
      tools.set(name, { schema: config.inputSchema ?? {}, handler });
    }) as never);
  }
  return tools;
}

const handlers = captureAll();

/** Minimal valid input per tool exercised below. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  search_models: { query: 'anime' },
  get_model: { ids: [4201] },
  get_model_version: { ids: [130072] },
  search_images: {},
  get_image: { ids: [31] },
  search_creators: { query: 'u' },
  list_enums: {},
  get_post: { id: 5 },
  get_article: { id: 6 },
};

/** REST bodies, enough for each Browse handler to format a result. */
function restBody(path: string): unknown {
  if (/^\/models\/\d+$/.test(path)) return { id: 4201, name: 'M', type: 'Checkpoint', modelVersions: [] };
  if (/^\/model-versions\/\d+$/.test(path))
    return { id: 130072, name: 'v1', modelId: 4201, model: { name: 'M', type: 'Checkpoint' }, files: [] };
  if (path === '/models') return { items: [], metadata: {} };
  if (path === '/images') return { items: [{ id: 31, url: 'https://img.test/31.png', meta: {} }], metadata: {} };
  if (path === '/creators') return { items: [], metadata: {} };
  if (path === '/enums') return { ModelType: ['Checkpoint'] };
  throw new Error(`unstubbed REST path ${path}`);
}

/**
 * Model of Civitai as an anonymous caller sees it: REST 200, tRPC 401 with the
 * real body. Records every URL fetched.
 */
function anonymousUpstream(): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    urls.push(url.pathname);
    if (url.pathname.startsWith('/api/trpc/')) {
      const path = url.pathname.slice('/api/trpc/'.length);
      return new Response(
        JSON.stringify({
          error: {
            json: {
              message: 'Please use the public API instead: https://developer.civitai.com/',
              code: -32001,
              data: { code: 'UNAUTHORIZED', httpStatus: 401, path },
            },
          },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.pathname.startsWith('/api/v1/')) {
      return new Response(JSON.stringify(restBody(url.pathname.slice('/api/v1'.length))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  });
  return urls;
}

async function runAnonymously(name: string) {
  const services = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }));
  expect(services.auth.hasKey()).toBe(false);
  const urls = anonymousUpstream();
  const entry = handlers.get(name);
  if (!entry) throw new Error(`no handler captured for ${name}`);
  const args = SAMPLE_ARGS[name];
  if (!args) throw new Error(`add SAMPLE_ARGS for ${name}`);
  // Same wrapper as createServer's registrar: a thrown upstream error becomes an isError result.
  let res: ToolResult;
  try {
    res = await entry.handler(z.object(entry.schema).parse(args) as Record<string, unknown>, services);
  } catch (err) {
    res = fail(err);
  }
  const text = res.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { res, text, urls };
}

afterEach(() => vi.restoreAllMocks());

const taggedPublic = createServer(parseConfig({}))
  .catalog.filter((t) => t.auth === 'public')
  .map((t) => t.name);

describe('every tool tagged public works with no key against the real anonymous upstream', () => {
  it.each(taggedPublic)('%s succeeds anonymously and never calls tRPC', async (name) => {
    const { res, text, urls } = await runAnonymously(name);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => u.startsWith('/api/trpc/'))).toEqual([]);
    expect(res.isError).not.toBe(true);
    expect(text).not.toContain('Failed:');
  });
});

describe('tRPC reads need a key (Civitai rejects anonymous tRPC)', () => {
  it.each(['get_post', 'get_article'])('%s fails with no key and is tagged required', async (name) => {
    const { res, text, urls } = await runAnonymously(name);
    expect(urls.some((u) => u.startsWith('/api/trpc/'))).toBe(true);
    expect(res.isError).toBe(true);
    expect(text).toContain('Please use the public API instead');
    const tag = createServer(parseConfig({})).catalog.find((t) => t.name === name)?.auth;
    expect(tag).toBe('required');
  });
});
