# Civitai MCP Server — Implementation Plan

## Goal

A standalone MCP server exposing Civitai's APIs as MCP tools, replacing/superseding two Claude skills:

- `C:\Users\Zipp4\.claude\skills\civitai-browse` (read-only browsing via public REST `/api/v1`)
- `C:\Dev\Repos\work\civitai\civitai-user-skill\skill` (authenticated user actions via tRPC `/api/trpc`)

**Read both skills before implementing.** They contain hard-won API knowledge (superjson hints, publish quirks, sanitization rules, AIR URN mapping). Port that knowledge; improve the ergonomics.

Deployment target: same k8s cluster as the Civitai app deployment. The API destination MUST be overridable via env so the server can talk to the in-cluster service instead of public civitai.com.

## Tech Stack

- TypeScript (strict), Node 20+
- `@modelcontextprotocol/sdk` (latest) — use `McpServer` high-level API with `registerTool`
- `zod` for all tool input schemas (SDK-native)
- Transports: **Streamable HTTP** (primary, for k8s) and **stdio** (local dev). Select via `MCP_TRANSPORT=http|stdio` (default `http`).
- No heavy deps. Native `fetch`. Keep the zero-dep spirit of the skills where reasonable (the MCP SDK + zod + a tiny http framework like `express` or raw `node:http` is fine; SDK examples use express — acceptable).
- Build: `tsup` or plain `tsc`. Test: `vitest`.

## Environment Variables (`.env.example` required)

| Var | Default | Purpose |
|---|---|---|
| `CIVITAI_API_URL` | `https://civitai.com` | Base URL for ALL API calls (REST + tRPC). In-cluster override, e.g. `http://civitai-app:3000` |
| `CIVITAI_API_KEY` | — | Bearer token for authenticated calls. Optional for browse tools (enhances results), required for user-action tools |
| `MCP_TRANSPORT` | `http` | `http` (Streamable HTTP) or `stdio` |
| `PORT` | `3100` | HTTP listen port |
| `CIVITAI_USER_ID` | — | Optional: skip the `user.getToken` JWT round-trip for self-id resolution |

Auth liberty (take it): in HTTP mode, if an incoming MCP request carries an `Authorization: Bearer <key>` header, use that key for upstream calls instead of the env key. Env key is the fallback. This makes the server multi-tenant-capable in-cluster without per-deployment keys. Document it.

## Architecture

```
src/
  index.ts            # entrypoint: env load, transport selection, server start
  server.ts           # McpServer construction, tool registration
  config.ts           # env parsing/validation (zod)
  client/
    rest.ts           # public /api/v1 client (GET helper, query building, error normalization)
    trpc.ts           # tRPC client (superjson input wrapping, meta.values type hints, error unwrap incl. zodError)
    auth.ts           # key resolution (request header > env), self-user-id resolution via user.getToken JWT
  lib/
    air.ts            # AIR URN: typeUrnMap + ecosystem detection (port from browse.mjs)
    markdown.ts       # md→HTML converter (port from civitai-user lib.mjs; article + comment variants)
    format.ts         # compact text formatters for tool results
  tools/
    browse.ts         # search/get tools
    articles.ts       # article tools
    comments.ts       # comment tools
    messaging.ts      # DM tool
    announcements.ts  # announcement tools (moderator)
    changelog.ts      # changelog tools (moderator)
    images.ts         # image upload tool
docs/PLAN.md
test/                 # vitest: air, markdown, trpc error unwrap, tool schema sanity
Dockerfile
k8s/deployment.example.yaml
README.md
.env.example
```

## Upstream API knowledge to port (critical)

### tRPC conventions (from `civitai-user-skill/skill/lib.mjs`)
- `POST {base}/api/trpc/{procedure}` body `{ json: input }`; GET variant uses `?input=<urlencoded JSON>`
- superjson meta hints: `{ json: input, meta: { values: { publishedAt: ['Date'] } } }` — without this, `z.date()` fields silently stay strings/null server-side
- Error unwrap: `err.error.json ?? err.error`; surface `data.zodError` validation details
- Result unwrap: `data.result?.data?.json ?? data.result?.data ?? data`
- Self user id: `user.getToken` (GET) → decode JWT payload → `userId`. Cache it.
- User lookup: numeric → `user.getById {id}` (GET); else `user.getCreator {username}` (GET)

### REST conventions (from `browse.mjs`)
- Base `{base}/api/v1`. Endpoints: `/models`, `/models/:id`, `/model-versions/:id`, `/images`, `/creators`, `/enums`, `/tags`, `/image-upload`
- Known API bug: when `query` + `types` combined, Meilisearch ignores the type filter — fetch limit 100 and filter client-side, same for `supportsGeneration` (see `searchModels` in browse.mjs)
- Single image fetch = `/images?imageId=<id>&withMeta=true` (no `/images/:id` endpoint)
- Enum validation: fetch `/enums` once (cache), case-insensitive match, return correctly-cased value, error lists allowed values

### Article/publish quirks (from `publish.mjs`)
- `article.upsert` requires full `title`+`content` every call → publish flow must `article.getById`, rebuild full payload, set `status='Published'` + `publishedAt=now` with the `['Date']` meta hint. Idempotent.
- `article.unpublish` is a clean dedicated endpoint `{ id, reason?, customMessage? }`

### Comments (from `comment.mjs`)
- Entity types: article, image, post, model, review, question, answer, comment, bounty, bountyEntry, clubPost, challenge, comicChapter
- Replies = comments with parent entity `comment:<parentId>`; recursion for threads
- Server sanitizes to `p, div, strong, em, u, s, a, br, span`
- Reactions: Like, Dislike, Laugh, Cry, Heart (toggle semantics)

### Image upload (two-step)
- `POST /api/v1/image-upload` `{}` → `{ id: uuid, uploadURL }`; PUT bytes to presigned URL; reference uuid (NOT http url) in article cover / announcement image

### AIR URNs
- `urn:air:{ecosystem}:{urnType}:civitai:{modelId}@{versionId}` — port `typeUrnMap` + `guessEcosystem` from browse.mjs verbatim, include AIR in all model/version tool outputs

## MCP Tools

Naming: `snake_case`, verb-first. Every tool: zod schema with `.describe()` on every field, good tool description (when to use, what it returns), and BOTH `structuredContent` (raw-ish JSON) and a compact human text block in `content`. Mark read-only tools with `annotations: { readOnlyHint: true }`; destructive ones `destructiveHint: true`.

### Browse (no auth required)
1. `search_models` — query, type, baseModel, sort, period, tag, username, supportsGeneration, limit, cursor. Client-side type filter workaround. Output includes AIR URNs + nextCursor.
2. `get_model` — `ids: number[]` (batch, concurrency 3). Full versions + AIR URNs.
3. `get_model_version` — `ids: number[]`. Files, trigger words, AIR.
4. `search_images` — query, modelId, modelVersionId, baseModel, username, sort, period, type, limit, cursor. `withMeta=true` always.
5. `get_image` — `ids: number[]`. Full generation metadata (prompt/negative/sampler/steps/cfg/seed/resources).
6. `search_creators` — query, limit, cursor.
7. `list_enums` — filter values reference.

### Articles (auth)
8. `upsert_article` — title, content (markdown → HTML via converter), id?, status, nsfwLevel, tags, cover handling (see 16). 
9. `publish_article` — id. Implements full getById→rebuild→upsert chain w/ Date hint. Idempotent.
10. `unpublish_article` — id, reason?, message?.
11. `get_article` — id (wraps `article.getById`; useful standalone).

### Comments (auth)
12. `list_comments` — entityType, entityId, depth (default 1), limit, sort, includeFull?. Recursive thread fetch. Aggregated reactions per comment.
13. `post_comment` — entityType, entityId, content (markdown→sanitized HTML), parentCommentId? (reply = comment-entity chaining handled internally — ONE tool for post+reply).
14. `edit_comment` / `delete_comment` / `react_to_comment` / `pin_comment` / `lock_thread` — merge into focused tools; pin/lock are moderator-gated upstream, note in descriptions.
15. `get_comment` — id, uncapped body.

### Messaging (auth)
16. `send_direct_message` — `user: string|number` (id or username), message. Chains lookup → chat.createChat → chat.createMessage internally. Markdown contentType.

### Images (auth)
17. `upload_image` — accepts `url` (server fetches bytes) or base64 `data`. Chains image-upload presign + PUT. Returns uuid + dimensions (use `image-size`-style probing or return what caller provided). This uuid feeds article covers / announcement images. **Liberty taken**: skills required manual curl; this makes cover flow one call. `upsert_article` should also accept `coverImageUrl` and chain the upload itself.

### Announcements (auth, moderator)
18. `upsert_announcement` — create/update unified (id present = update w/ field merge from current row). title, content, color, domains, startsAt (default now on create), endsAt, image uuid or url (chain upload), buttons, targetAudience, colSpan, dismissible, disabled.
19. `delete_announcement` — id.
20. `list_announcements` — `scope: 'all'|'current'`, domain?, limit.

### Changelog (auth, moderator + changelogEdit flag)
21. `upsert_changelog` — create/update unified; markdown→HTML; type, titleColor, link, cta, effectiveAt, tags, domains, sticky, disabled.

### Utility
22. `whoami` — resolves current user from API key (id, username, moderator?). Good smoke test for deploys.

Read the skill `.mjs` sources for exact tRPC procedure names and payload shapes (`announcement.mjs`, `changelog.mjs`, `comment.mjs`, `article.mjs`, `publish.mjs`, `dm.mjs`).

## Liberties explicitly endorsed

- Merge create/update into upsert tools where server API allows
- Chain multi-step flows behind single tools (cover upload, publish rebuild, DM chat-create, reply-as-comment-entity)
- Unified error shape: `{ ok: false, error, details? }` in structuredContent + isError content
- Pagination: return `nextCursor` in structured output, describe in tool description
- Drop CLI-isms (no `--dry-run`; MCP clients can inspect schemas). Keep `dryRun?: boolean` ONLY on destructive/publish tools if cheap.

## Non-goals

- No generation tools (civitai-gen stays separate)
- No moderation actions (mod-actions skill scope)
- No model file downloads

## Deployment artifacts

- `Dockerfile`: multi-stage, node:20-alpine, non-root, `HEALTHCHECK` hitting `/healthz`
- `/healthz` endpoint in HTTP mode (plain 200, no upstream calls)
- `k8s/deployment.example.yaml`: Deployment + Service, env from Secret (`CIVITAI_API_KEY`), `CIVITAI_API_URL` pointing at in-cluster service, readiness/liveness probes on `/healthz`
- README: setup, env table, tool catalog, local dev (stdio + MCP inspector), Docker build, k8s notes, Claude Code `.mcp.json` example

## Quality bar

- `pnpm build` clean, `pnpm test` green, strict TS, no `any` leakage in tool handlers
- Unit tests: air.ts (urn map + ecosystem guesses), markdown.ts (article + comment variants, escaping), trpc error unwrap (zodError surfacing), config parsing
- Tool handlers must never throw raw — catch, normalize, return `isError: true` with useful message (include zodError details)
