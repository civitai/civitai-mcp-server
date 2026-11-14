import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { createServer, type ToolModule } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { postTools } from '../src/tools/posts.js';
import { articleTools } from '../src/tools/articles.js';

/**
 * The `auth` tag drives the HTTP-layer OAuth 401 challenge, so a read tool
 * wrongly tagged `required` gets challenged although it works without a key.
 * The default comes from the category (only Browse is public), so reads in
 * other categories must opt out explicitly.
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
  'get_post',
  'get_article',
];

describe('tool auth tags', () => {
  it('tags exactly the anonymous tools public', () => {
    const { catalog } = createServer(parseConfig({}));
    const publicTools = catalog.filter((t) => t.auth === 'public').map((t) => t.name);
    expect(publicTools.sort()).toEqual([...PUBLIC_TOOLS].sort());
  });
});

type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

function capture(mod: ToolModule): Map<string, { schema: ZodRawShape; handler: Handler }> {
  const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
  mod(((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
    tools.set(name, { schema: config.inputSchema ?? {}, handler });
  }) as never);
  return tools;
}

const handlers = new Map([...capture(postTools), ...capture(articleTools)]);

/** Canned upstream rows, enough for each handler to format a result. */
const UPSTREAM: Record<string, unknown> = {
  'post.get': { id: 5, title: 'A post', publishedAt: null, user: { id: 1, username: 'u' } },
  'article.getById': { id: 6, title: 'An article', status: 'Published', publishedAt: null, tags: [] },
};

afterEach(() => vi.restoreAllMocks());

describe('reads outside Browse run without an API key', () => {
  it.each([
    ['get_post', { id: 5 }],
    ['get_article', { id: 6 }],
  ])('%s succeeds with no key', async (name, args) => {
    const services = buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test' }));
    expect(services.auth.hasKey()).toBe(false);
    vi.spyOn(services.trpc, 'call').mockImplementation(async (procedure: string) => {
      if (!(procedure in UPSTREAM)) throw new Error(`unexpected procedure ${procedure}`);
      return UPSTREAM[procedure] as never;
    });
    const { schema, handler } = handlers.get(name)!;
    const res = await handler(z.object(schema).parse(args) as Record<string, unknown>, services);
    expect(res.isError).not.toBe(true);
  });
});
