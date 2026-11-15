# Contributing

Thanks for your interest in improving the Civitai MCP server.

## Local setup

```bash
pnpm install
cp .env.example .env   # optional: set CIVITAI_API_KEY to exercise auth tools
pnpm dev               # hot-reload dev server (stdio/http per MCP_TRANSPORT)
```

## Before opening a PR

Run the full quality gate - all four must be clean:

```bash
pnpm typecheck      # strict tsc, no emit
pnpm test           # vitest (no network; fetch is mocked)
pnpm build          # tsc to dist
pnpm readme:check   # README tool catalog matches the tool registry
```

Try tools interactively with the MCP Inspector:

```bash
pnpm inspector
```

## Conventions

- TypeScript strict mode; no `any` leaking into tool handlers.
- Tool handlers never throw raw - catch and return the normalized
  `{ ok: false, error, details? }` error shape with `isError: true`.
- Every tool input field gets a zod `.describe()`.
- The landing page, `llms.txt` and the README tool catalog are all generated
  from the live tool registry (`createServer(config).catalog`; see
  `src/lib/landing.ts` and `src/lib/readme-catalog.ts`). Don't hand-edit tool
  lists: run `pnpm readme:catalog` after changing a tool's name, description,
  category, annotations or `auth`. `pnpm test` (`test/readme-catalog.test.ts`)
  fails when the README is stale; `pnpm readme:check` runs the same check alone.
- Add or update tests for any behavior change.

## Adding a tool

1. Add a `reg(name, config, handler)` registration in the relevant
   `src/tools/*.ts` module (or a new module wired into `src/server.ts`).
2. Mark read-only tools with `annotations: { readOnlyHint: true }` and
   destructive ones with `destructiveHint: true`.
   Tag a tool `auth: 'public'` only if it works with no key: Civitai's REST
   `/api/v1` answers anonymous callers, its tRPC API answers them with 401.
   `test/tool-auth.test.ts` runs every public tool against that anonymous
   upstream and pins the public set.
3. Run `pnpm readme:catalog` to regenerate the README tool catalog, and commit
   the result.
4. Add tests.

## Pull requests

Keep PRs focused. Describe the change, the upstream procedure(s) it wraps, and
any auth/scope/flag requirements. Link related issues.

By contributing you agree your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
