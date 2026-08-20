import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { parseConfig } from '../src/config.js';
import { buildServices, type Services, type ToolResult } from '../src/tools/helpers.js';
import { engagementTools } from '../src/tools/engagement.js';

/**
 * Self-contained so it never collides with other test files: this suite lives in
 * its own file rather than appended to community-tools.test.ts, which every
 * concurrent branch was also appending to.
 */
type Handler = (args: Record<string, unknown>, services: Services) => Promise<ToolResult>;

function collect(mod: (reg: never) => void): Map<string, { schema: ZodRawShape; handler: Handler }> {
  const tools = new Map<string, { schema: ZodRawShape; handler: Handler }>();
  const reg = ((name: string, config: { inputSchema?: ZodRawShape }, handler: Handler) => {
    tools.set(name, { schema: config.inputSchema ?? {}, handler });
  }) as unknown as never;
  mod(reg);
  return tools;
}

function services(): Services {
  return buildServices(parseConfig({ CIVITAI_API_URL: 'https://x.test', CIVITAI_API_KEY: 'k' }));
}

function parse(schema: ZodRawShape, args: Record<string, unknown>): Record<string, unknown> {
  return z.object(schema).parse(args) as Record<string, unknown>;
}

function stubTrpc(svc: Services, responder: (procedure: string, input: unknown) => unknown): void {
  vi.spyOn(svc.trpc, 'call').mockImplementation(
    async (procedure: string, input: unknown) => responder(procedure, input) as never
  );
}

afterEach(() => vi.restoreAllMocks());

describe('get_my_resource_review', () => {
  // Upstream returns `[]` when no review exists. An empty array is truthy, so the
  // tool used to report reviewed:true with every field undefined — a wrong answer
  // an agent would act on.
  it.each([
    ['an empty array', [] as unknown],
    ['null', null as unknown],
    ['an object with no id', {} as unknown],
  ])('reports reviewed:false for %s', async (_label, upstream) => {
    const tools = collect(engagementTools);
    const svc = services();
    stubTrpc(svc, () => upstream);

    const t = tools.get('get_my_resource_review')!;
    const res = await t.handler(parse(t.schema, { modelVersionId: 2875803 }), svc);

    expect(res.structuredContent).toEqual({ reviewed: false });
    expect(JSON.stringify(res)).toContain('have not reviewed');
  });

  it('reports the review when one exists, including the array shape', async () => {
    const tools = collect(engagementTools);
    const svc = services();
    stubTrpc(svc, () => [{ id: 42, rating: 5, recommended: true, details: 'great' }]);

    const t = tools.get('get_my_resource_review')!;
    const res = await t.handler(parse(t.schema, { modelVersionId: 1 }), svc);

    expect(res.structuredContent).toMatchObject({ reviewed: true, id: 42, rating: 5 });
  });
});
