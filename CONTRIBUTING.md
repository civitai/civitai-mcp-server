# Contributing

Thanks for your interest in improving the Civitai MCP server.

## Local setup

```bash
pnpm install
cp .env.example .env   # optional: set CIVITAI_API_KEY to exercise auth tools
pnpm dev               # hot-reload dev server (stdio/http per MCP_TRANSPORT)
```

## Before opening a PR

Run the full quality gate - all three must be clean:

```bash
pnpm typecheck   # strict tsc, no emit
pnpm test        # vitest (no network; fetch is mocked)
pnpm build       # tsc to dist
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
- The landing page and `llms.txt` tool catalog are generated from the live tool
  registry (see `src/lib/landing.ts`). Don't hand-duplicate tool lists; if you
  add a tool, the catalog and the README table should reflect it.
- Add or update tests for any behavior change.

## Adding a tool

1. Add a `reg(name, config, handler)` registration in the relevant
   `src/tools/*.ts` module (or a new module wired into `src/server.ts`).
2. Mark read-only tools with `annotations: { readOnlyHint: true }` and
   destructive ones with `destructiveHint: true`.
3. Update the README tool catalog table and the tool count.
4. Add tests.

## Pull requests

Keep PRs focused. Describe the change, the upstream procedure(s) it wraps, and
any auth/scope/flag requirements. Link related issues.

By contributing you agree your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
