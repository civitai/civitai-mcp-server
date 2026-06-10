# Civitai MCP Server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes Civitai's public REST (`/api/v1`) and authenticated tRPC (`/api/trpc`)
APIs as MCP tools: browsing models/images/creators, writing and publishing
articles, managing comments, sending DMs, uploading images, and managing site
announcements and changelog entries.

It supersedes two Claude skills (`civitai-browse`, `civitai-user`), porting their
hard-won API knowledge (AIR URN mapping, the Meilisearch query+type bug
workaround, superjson `meta.values` date hints, the article publish-rebuild flow,
comment reply-as-comment-entity chaining, two-step image upload).

Built for in-cluster deployment next to the Civitai app — the API destination is
fully overridable via `CIVITAI_API_URL`.

## Quick start

```bash
pnpm install
cp .env.example .env   # set CIVITAI_API_KEY for authenticated tools
pnpm build
pnpm start             # HTTP mode on :3100, GET /healthz, POST /mcp
```

For local development with hot reload:

```bash
pnpm dev
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `CIVITAI_API_URL` | `https://civitai.com` | Base URL for **all** API calls (REST + tRPC). In-cluster override, e.g. `http://civitai-app:3000`. |
| `CIVITAI_API_KEY` | — | Bearer token for authenticated calls. Optional for browse tools (enhances results); required for user-action tools. In HTTP mode it is the fallback when a request omits an `Authorization` header. |
| `MCP_TRANSPORT` | `http` | `http` (Streamable HTTP) or `stdio` (local dev / desktop MCP clients). |
| `PORT` | `3100` | HTTP listen port (http transport only). |
| `CIVITAI_USER_ID` | — | Optional: skip the `user.getToken` JWT round-trip for self-id resolution. |

### Per-request auth (multi-tenant)

In HTTP mode, if an incoming MCP request carries `Authorization: Bearer <key>`,
that key is used for upstream calls instead of `CIVITAI_API_KEY`. The env key is
the fallback. This lets one in-cluster deployment serve multiple users without a
per-deployment key. In stdio mode only the env key is used.

## Transports

- **Streamable HTTP** (default, for k8s): `POST /mcp`. Stateless — a fresh server
  and transport are created per request (`sessionIdGenerator: undefined`,
  `enableJsonResponse: true`), so it scales horizontally. `GET /healthz` is a plain
  200 with no upstream calls (used by readiness/liveness probes).
- **stdio**: set `MCP_TRANSPORT=stdio`. stdout is reserved for the protocol; logs
  go to stderr.

## Tool catalog (26 tools)

### Browse (no auth required)
| Tool | Description |
|---|---|
| `search_models` | Search models. Includes AIR URNs + `nextCursor`. Client-side type-filter workaround for the Meilisearch query+type bug. |
| `get_model` | Batch model details (concurrency 3): versions, files, AIR URNs. |
| `get_model_version` | Batch version details: files, trigger words, AIR. |
| `search_images` | Search images with full generation metadata (`withMeta=true`). |
| `get_image` | Batch image details: prompt, negative, sampler, steps, CFG, seed, resources. |
| `search_creators` | Search creators/users. |
| `list_enums` | List filter enum values (model types, sorts, base models, timeframes). |

### Articles (auth)
| Tool | Description |
|---|---|
| `upsert_article` | Create/update. Markdown→HTML. Cover by UUID or URL (auto-uploaded). |
| `publish_article` | getById→rebuild→upsert with the `publishedAt: ['Date']` hint. Idempotent. |
| `unpublish_article` | Dedicated `article.unpublish`. |
| `get_article` | Fetch by ID. |

### Comments (auth)
| Tool | Description |
|---|---|
| `list_comments` | Recursive thread fetch with per-comment reaction aggregation. |
| `get_comment` | Single comment, uncapped body. |
| `post_comment` | Post or reply (reply via `parentCommentId` → comment-entity chaining). |
| `edit_comment` / `delete_comment` / `react_to_comment` | Edit, delete, toggle reaction. |
| `pin_comment` / `lock_thread` | Moderator-gated upstream. |

### Messaging (auth)
| Tool | Description |
|---|---|
| `send_direct_message` | Lookup → `chat.createChat` → `chat.createMessage`. Markdown. |

### Images (auth)
| Tool | Description |
|---|---|
| `upload_image` | URL or base64 → presign → PUT → UUID (+ probed dimensions). |

### Announcements (auth, moderator)
| Tool | Description |
|---|---|
| `upsert_announcement` | Create/update with field merge. Image by UUID or URL. `startsAt` defaults to now on create. |
| `delete_announcement` | Delete by ID. |
| `list_announcements` | `scope: current` (live) or `all` (paginated, moderator). |

### Changelog (auth, moderator + `changelogEdit` flag)
| Tool | Description |
|---|---|
| `upsert_changelog` | Create/update. Markdown→HTML; `effectiveAt: ['Date']` hint. |

### Utility
| Tool | Description |
|---|---|
| `whoami` | Resolve the current user (id, username, moderator?). Good deploy smoke test. |

Every tool returns both a compact human-readable text block and a
`structuredContent` JSON payload. Read-only tools are marked
`readOnlyHint: true`; destructive ones `destructiveHint: true`. Errors are
normalized to `{ ok: false, error, details? }` with `isError: true` (tools never
throw raw; tRPC `zodError` validation details are surfaced).

## Local dev with the MCP Inspector

```bash
pnpm inspector   # runs: npx @modelcontextprotocol/inspector tsx src/index.ts
```

This launches the Inspector against the stdio transport. Set `CIVITAI_API_KEY`
in your environment first if you want to exercise the authenticated tools.

## Claude Code `.mcp.json`

stdio (recommended for local agents):

```json
{
  "mcpServers": {
    "civitai": {
      "command": "node",
      "args": ["C:/path/to/civitai-mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "CIVITAI_API_KEY": "your_key_here"
      }
    }
  }
}
```

HTTP (pointing at a running server):

```json
{
  "mcpServers": {
    "civitai": {
      "type": "http",
      "url": "http://localhost:3100/mcp",
      "headers": { "Authorization": "Bearer your_key_here" }
    }
  }
}
```

## Docker

```bash
docker build -t civitai-mcp-server .
docker run --rm -p 3100:3100 -e CIVITAI_API_KEY=your_key civitai-mcp-server
curl localhost:3100/healthz
```

Multi-stage build on `node:20-alpine`, runs as the non-root `node` user, with a
`HEALTHCHECK` hitting `/healthz`.

## Kubernetes

See [`k8s/deployment.example.yaml`](k8s/deployment.example.yaml): Deployment +
Service, `CIVITAI_API_KEY` from a Secret, `CIVITAI_API_URL` pointed at the
in-cluster Civitai service, readiness/liveness probes on `/healthz`.

## Development

```bash
pnpm typecheck   # strict tsc, no emit
pnpm test        # vitest (no network — fetch is mocked)
pnpm build       # tsc -> dist
```

## Non-goals

- No generation tools (use civitai-gen).
- No moderation actions (use the mod-actions tooling).
- No model file downloads.
