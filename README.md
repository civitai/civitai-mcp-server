# Civitai MCP Server

Turn your AI agent into a full Civitai participant.

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI
agents first-class access to Civitai: browse models, images, and creators; post
and publish work; react, review, follow, and collect; write articles and
comments; send and reply to direct messages; create and enter bounties; and
(for moderators) manage site announcements and the changelog. 53 tools, exposed
over Streamable HTTP or stdio.

![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP%20%7C%20stdio-7c3aed)

There are two ways to use it:

1. **Hosted (recommended)** — point your MCP client at `https://mcp.civitai.com/mcp`. Zero install.
2. **Self-host** — run it yourself with pnpm, Docker, or in Kubernetes.

---

## Quick start — hosted (recommended)

The easiest path: add the hosted endpoint to your MCP client and supply your own
Civitai API key. Nothing to install or run.

- **MCP endpoint:** `https://mcp.civitai.com/mcp`
- **Transport:** Streamable HTTP
- **Auth:** send `Authorization: Bearer <YOUR_CIVITAI_API_KEY>` with each request

Browse / read tools (search models, images, creators, etc.) work **without** a
key. Everything that writes (posting, reacting, commenting, DMs, bounties, ...)
needs one. Grab a key at [civitai.com/user/account](https://civitai.com/user/account).

### Claude Code (CLI)

```bash
claude mcp add --transport http civitai https://mcp.civitai.com/mcp \
  --header "Authorization: Bearer YOUR_CIVITAI_API_KEY"
```

### Claude Desktop / claude.ai (custom connector)

> **Note:** the claude.ai / Claude Desktop custom-connector UI is **OAuth-only** — it
> has no field for a static API key or custom header
> ([anthropics/claude-ai-mcp#112](https://github.com/anthropics/claude-ai-mcp/issues/112)).
> Because this server currently runs in **token-only** mode (`OAUTH_ENABLED=false`), the
> custom-connector flow won't work yet. Use **Claude Code**, **Cursor**, or any client that
> supports a bearer header. One-click OAuth connect will work here once Civitai OAuth ships
> and `OAUTH_ENABLED=true`.

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "civitai": {
      "url": "https://mcp.civitai.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_CIVITAI_API_KEY" }
    }
  }
}
```

### Generic `.mcp.json` (any client)

```json
{
  "mcpServers": {
    "civitai": {
      "type": "http",
      "url": "https://mcp.civitai.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_CIVITAI_API_KEY" }
    }
  }
}
```

> **Tip:** hand your agent `https://mcp.civitai.com/llms.txt` (or just
> `https://mcp.civitai.com/`) and it can read everything it needs - endpoint,
> transport, auth, and the full tool catalog - to configure itself. See
> [The `/llms.txt` trick](#the-llmstxt-trick).

### CLI (no MCP client needed)

Some agent runtimes can load a skill but can't edit their MCP client config (no
way to add an HTTP MCP server). For those, pull the zero-dependency Node CLI
(Node >=18) and drive the server straight from the shell - no MCP client config:

```bash
curl -fsSL https://mcp.civitai.com/cli -o mcp-cli.mjs
node mcp-cli.mjs list
node mcp-cli.mjs call search_models '{"query":"anime","type":"Checkpoint"}'
```

Set `CIVITAI_API_KEY` in your environment for user-action tools (browse/read
tools work without it). The pulled script defaults to the server it came from;
override with `MCP_URL` or `--url`. Add `--json` for the raw JSON-RPC result,
`schema <tool>` to inspect a tool's input schema, or `--help` for usage.

---

## Self-host

Prefer to run your own instance (private deployment, in-cluster next to the
Civitai app, or local dev)? All three paths below work. The API destination is
fully overridable via `CIVITAI_API_URL`.

### pnpm

```bash
pnpm install
cp .env.example .env   # set CIVITAI_API_KEY for authenticated tools (optional)
pnpm build
pnpm start             # HTTP mode on :3100, GET /healthz, POST /mcp
```

For local development with hot reload:

```bash
pnpm dev
```

### Docker

Prebuilt images are published to GHCR:

```bash
docker run --rm -p 3100:3100 \
  -e CIVITAI_API_KEY=YOUR_CIVITAI_API_KEY \
  ghcr.io/civitai/civitai-mcp-server:latest
curl localhost:3100/healthz
```

Or build locally:

```bash
docker build -t civitai-mcp-server .
docker run --rm -p 3100:3100 -e CIVITAI_API_KEY=YOUR_CIVITAI_API_KEY civitai-mcp-server
```

Multi-stage build on `node:20-alpine`, runs as the non-root `node` user, with a
`HEALTHCHECK` hitting `/healthz`.

### Kubernetes

See [`k8s/deployment.example.yaml`](k8s/deployment.example.yaml): Deployment +
Service, `CIVITAI_API_KEY` from a Secret, `CIVITAI_API_URL` pointed at the
in-cluster Civitai service, readiness/liveness probes on `/healthz`.

### Local stdio (for agents that spawn a process)

```json
{
  "mcpServers": {
    "civitai": {
      "command": "node",
      "args": ["/path/to/civitai-mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "CIVITAI_API_KEY": "YOUR_CIVITAI_API_KEY"
      }
    }
  }
}
```

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `CIVITAI_API_URL` | `https://civitai.com` | Base URL for **all** API calls (REST + tRPC). In-cluster override, e.g. `http://civitai-app:3000`. |
| `CIVITAI_WEB_URL` | `https://civitai.com` | Public website base for user-facing links in tool output (post/model/image/profile URLs). Distinct from `CIVITAI_API_URL`, which may point at an internal cluster service — links handed to users must stay public. The `civitai.com` default is correct for the hosted deployment; only override for `civitai.red` or a self-host on another domain. |
| `CIVITAI_API_KEY` | — | Bearer token for authenticated calls. Optional for browse tools (enhances results); required for user-action tools. In HTTP mode it is the fallback when a request omits an `Authorization` header. |
| `MCP_TRANSPORT` | `http` | `http` (Streamable HTTP) or `stdio` (local dev / desktop MCP clients). |
| `PORT` | `3100` | HTTP listen port (http transport only). |
| `PUBLIC_BASE_URL` | — | Optional canonical public base URL (e.g. `https://mcp.civitai.com`). When set, the advertised MCP endpoint in the landing page / `llms.txt` uses this instead of deriving it from the request `Host` header. Set it on the canonical hosted deployment so it always advertises its public address even behind proxies that don't forward `Host`/`X-Forwarded-*` reliably. Default: unset (Host-derived). |
| `OAUTH_ENABLED` | `false` | Gates one-click OAuth (RFC 9728 protected-resource metadata + the 401 `WWW-Authenticate` challenge). Off = token-only mode. Turn on only once Civitai's OAuth dynamic client registration is live. See [OAuth one-click connect](#oauth-one-click-connect-opt-in-off-by-default). |
| `CIVITAI_USER_ID` | — | Optional: skip the `user.getToken` JWT round-trip for self-id resolution. |
| `CIVITAI_UPLOAD_MAX_BYTES` | `10485760` | Max bytes accepted for an image fetched/decoded by `upload_image` (10 MB). Guards against memory exhaustion. |
| `CIVITAI_UPLOAD_ALLOWED_HOSTS` | — | CSV allowlist of hostnames permitted for URL-based image uploads. When set, only these hosts (and subdomains) may be fetched. Empty = block only internal/private/loopback/metadata targets (default SSRF guard). |
| `MCP_ALLOWED_HOSTS` | — | CSV of `Host` values allowed by DNS-rebinding protection. When set, protection is enabled and only these hosts may reach `/mcp`. Leave empty in-cluster (behind ingress); set for localhost dev, e.g. `localhost:3100,127.0.0.1:3100`. |

#### Per-request auth (multi-tenant)

In HTTP mode, if an incoming MCP request carries `Authorization: Bearer <key>`,
that key is used for upstream calls instead of `CIVITAI_API_KEY`. The env key is
the fallback. This lets one deployment serve multiple users without a
per-deployment key (this is how the hosted instance works). In stdio mode only
the env key is used.

---

## Tool catalog (53 tools)

Every tool returns both a compact human-readable text block and a
`structuredContent` JSON payload. Read-only tools are marked `readOnlyHint: true`;
destructive ones `destructiveHint: true`. Errors are normalized to
`{ ok: false, error, details? }` with `isError: true` (tools never throw raw;
tRPC `zodError` validation details are surfaced). The catalog below is the single
source of truth from the live tool registry - the landing page and `llms.txt`
render the same list.

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

### Posts (auth - onboarded, non-muted)
| Tool | Description |
|---|---|
| `create_post` | Flagship sharing flow via the composite `post.createWithImages` (ONE atomic call: create + ordered images + optional publish; server handles cleanup). Images by UUID or URL (auto-uploaded); sequential `index`. `publishedAt` returns as a Date. MediaWrite scope. |
| `get_post` | Fetch a post by ID. |
| `publish_post` | Publish a draft via `post.update { publishedAt }` (Date hint). |
| `delete_post` | Delete a post you own. |

### Engagement (auth)
| Tool | Description |
|---|---|
| `react` | Toggle Like/Dislike/Laugh/Cry/Heart on image/post/article/comment/resourceReview/etc. `reaction.toggle` is fire-and-forget (200 != confirmed). Guarded. |
| `upsert_resource_review` | Star rating (1-5) + recommend + Markdown details. `resourceReview.upsert`. Guarded. |
| `get_my_resource_review` | Read your existing review for a model version. |
| `toggle_follow_user` | Follow/unfollow (resolves username to id). `user.toggleFollow`. Verified. |
| `toggle_favorite_model` | Favorite/bookmark a model (explicit `setTo`). `user.toggleFavorite`. |
| `notify_model` | Toggle new-version notifications. `user.toggleNotifyModel`. |
| `toggle_bookmark_article` | Bookmark/un-bookmark an article. `user.toggleBookmarkedArticle`. Verified. |
| `complete_onboarding_step` | Complete TOS/RedTOS/Profile/BrowsingLevels/Buzz. Prerequisite for any verified/guarded write. |

### Articles (auth)
| Tool | Description |
|---|---|
| `upsert_article` | Create/update. Markdown to HTML. Cover by UUID or URL (auto-uploaded). |
| `publish_article` | getById to rebuild to upsert with the `publishedAt: ['Date']` hint. Idempotent. |
| `unpublish_article` | Dedicated `article.unpublish`. |
| `get_article` | Fetch by ID. |

### Comments (auth)
| Tool | Description |
|---|---|
| `list_comments` | Recursive thread fetch with per-comment reaction aggregation. |
| `get_comment` | Single comment, uncapped body. |
| `post_comment` | Post or reply (reply via `parentCommentId` to comment-entity chaining). |
| `edit_comment` / `delete_comment` / `react_to_comment` | Edit, delete, toggle reaction. |
| `pin_comment` / `lock_thread` | Moderator-gated upstream. |

### Collections (auth - flag-gated `collections`)
| Tool | Description |
|---|---|
| `upsert_collection` | Create/update a collection. `collection.upsert`. Guarded. |
| `add_to_collection` | Save one item (article/image/post/model) into one or more collections. `collection.saveItem` (exactly one id field + `collections[]`). |
| `follow_collection` | Follow/unfollow a collection. |

### Notifications (auth)
| Tool | Description |
|---|---|
| `list_notifications` | List notifications (unread/category filters). `cursor: ['Date']` hint applied; returns `nextCursor`. |
| `mark_notifications_read` | Mark one (`id` as string, bigint hint) / `all` / a `category` read. |
| `check_notifications` | Quick unread count. `user.checkNotifications`. |

### Messaging (auth)
| Tool | Description |
|---|---|
| `send_direct_message` | Lookup to `chat.createChat` to `chat.createMessage`. Markdown. Starts a NEW chat. |

### Chat (auth) - read & reply to existing threads
| Tool | Description |
|---|---|
| `list_chats` | List your conversations + participants. |
| `get_chat_messages` | Read a chat's messages (paginated, `nextCursor`). |
| `reply_to_chat` | Send into an existing chat (`chat.createMessage`, Markdown, <=2000 chars). |
| `mark_chat_read` | Mark ONE chat read via `chat.markChatRead { chatId }` (advances `lastViewedMessageId`). |
| `mark_all_chats_read` | Blanket clear of every conversation via `chat.markAllAsRead`. |

### Bounties (auth - flag-gated `bounties`)
| Tool | Description |
|---|---|
| `create_bounty` | Create via `bounty.create` (NOT `bounty.upsert` - blocked for API keys). `startsAt`/`expiresAt` Date hints; >=1 example image (UUID or URL). |
| `update_bounty` | Update a bounty you own. `bounty.update`. |
| `create_bounty_entry` | Submit an entry via the composite `bountyEntry.submit` (>=1 pre-uploaded file ref `{url,name,sizeKB}` + >=1 image UUID/URL). BountiesWrite scope. |
| `award_bounty` | Award a bounty to an entry. `bountyEntry.award { id }`. |

### Announcements (auth, moderator)
| Tool | Description |
|---|---|
| `upsert_announcement` | Create/update with field merge. Image by UUID or URL. `startsAt` defaults to now on create. |
| `delete_announcement` | Delete by ID. |
| `list_announcements` | `scope: current` (live) or `all` (paginated, moderator). |

### Changelog (auth, moderator + `changelogEdit` flag)
| Tool | Description |
|---|---|
| `upsert_changelog` | Create/update. Markdown to HTML; `effectiveAt: ['Date']` hint. |

### Images (auth)
| Tool | Description |
|---|---|
| `upload_image` | URL or base64 to presign to PUT to UUID (+ probed dimensions). |

### Utility
| Tool | Description |
|---|---|
| `whoami` | Resolve the current user (id, username) and authoritative status via `user.getSelfStatus`: real `isOnboarded` + `completedSteps`, `muted`, `isModerator`, subscription `tier`. Good deploy smoke test. |

---

## Auth & scopes

- **API key:** create one at [civitai.com/user/account](https://civitai.com/user/account)
  and send it as `Authorization: Bearer <key>`. In HTTP mode the per-request
  header overrides any `CIVITAI_API_KEY` env fallback.
- **Browse without a key:** all `search_*` / `get_*` browse tools work
  unauthenticated (a key just enriches results).
- **Onboarded, non-muted account:** most write actions are `verified` (requires
  onboarding) or `guarded` (also blocks muted users). A fresh agent account must
  finish onboarding first - use `complete_onboarding_step`. `whoami` reports the
  current onboarding/muted/moderator state.
- **Scoped tokens:** if you use a scoped token (rather than a Full key), it must
  carry the write scope a tool needs (e.g. `MediaWrite`, `SocialWrite`,
  `BountiesWrite`, `CollectionsWrite`). A Full key passes everything.
- **API-key-blocked actions:** a few site actions are intentionally unavailable
  to API keys (e.g. tipping buzz) and are not shipped as tools.

### OAuth one-click connect (opt-in, off by default)

> **Off by default.** Set `OAUTH_ENABLED=true` to turn this on. It is gated
> because it only works once the Civitai app's OAuth dynamic-client-registration
> (DCR) is live - with it off the server runs in **token-only** mode (supply an
> API key via `Authorization: Bearer`; an unauthenticated auth-required call
> returns the normal "set `CIVITAI_API_KEY`" error). With `OAUTH_ENABLED` unset
> or false, the metadata endpoint 404s and no 401 challenge is emitted.

The server is an OAuth 2.0 *resource server* (RFC 9728 / RFC 6750). When
`OAUTH_ENABLED=true` and the Civitai app's DCR is live, MCP clients can connect
with no manually pasted API key - they discover the authorization server and run
the standard authorization-code flow on first use:

1. The client `POST`s a `tools/call` for an auth-required tool **without** an
   `Authorization` header.
2. The server replies **HTTP 401** with
   `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`.
3. The client fetches `GET /.well-known/oauth-protected-resource`, learns the
   authorization server (`https://civitai.com`) and supported scopes, registers
   itself (DCR), runs the OAuth flow, and retries with a bearer token.

Two behaviors back this:

- **`GET /.well-known/oauth-protected-resource`** - Protected Resource Metadata:
  the advertised `resource` (the `/mcp` endpoint), `authorization_servers`
  (`CIVITAI_API_URL`), `scopes_supported` (canonical scope names), and
  `bearer_methods_supported: ["header"]`.
- **401 challenge** - a `tools/call` for an auth-`required` tool with no
  `Authorization: Bearer` is short-circuited at the HTTP layer with a 401 +
  challenge (instead of a deeper JSON-RPC `200 + isError` the client can't act
  on). Browse/read tools stay anonymous; `initialize`, `tools/list`,
  `notifications/*`, and `ping` are never challenged. In a batch, if **any** call
  needs auth and no bearer is present, the whole request is challenged. The token
  is not validated here (presence is enough); a bad token surfaces as a tool
  error upstream.

> **Prod note:** set `PUBLIC_BASE_URL=https://mcp.civitai.com` so the advertised
> `resource` exactly matches the URL clients call - OAuth resource matching is
> strict, and a Host-derived mismatch would break token audience validation.

---

## The `/llms.txt` trick

The server exposes an [llms.txt](https://llmstxt.org)-style self-setup guide.
Hand your agent the URL and it can configure itself - it reads the MCP endpoint,
transport, auth instructions, and the full tool catalog with no human in the
loop:

```
https://mcp.civitai.com/llms.txt
```

`https://mcp.civitai.com/` content-negotiates on `User-Agent`: a browser gets a
self-contained HTML landing page; anything else (curl, fetch, agents, missing UA)
gets the `llms.txt` text. The advertised endpoint is derived from the request
`Host` header (honoring `X-Forwarded-Proto`/`-Host`), or pinned via
`PUBLIC_BASE_URL`, so it is always correct for the deployment serving it.

---

## Transports

- **Streamable HTTP** (default): `POST /mcp`. Stateless - a fresh server and
  transport are created per request (`sessionIdGenerator: undefined`,
  `enableJsonResponse: true`), so it scales horizontally. `GET /healthz` is a
  plain 200 with no upstream calls (used by readiness/liveness probes).
- **stdio**: set `MCP_TRANSPORT=stdio`. stdout is reserved for the protocol;
  logs go to stderr.

### HTTP endpoints

| Method & path | Purpose |
|---|---|
| `POST /mcp` | MCP Streamable HTTP endpoint (JSON-RPC). |
| `GET /healthz` | Plain 200 liveness/readiness probe (no upstream calls). |
| `GET /` | Dual-audience index: browser UA gets HTML; everything else gets `llms.txt` as `text/plain`. |
| `GET /llms.txt` | The agent self-setup guide as `text/plain`. |
| `GET /cli` | The pullable zero-dependency Node CLI (`mcp-cli.mjs`), with this server's `/mcp` endpoint baked in. For runtimes that can't add an MCP server to their config. |

---

## Security

- **SSRF guard:** `upload_image` fetches user-supplied URLs through a guard that
  blocks internal/private/loopback/metadata targets by default, with an optional
  `CIVITAI_UPLOAD_ALLOWED_HOSTS` allowlist.
- **Size cap:** fetched/decoded images are capped at
  `CIVITAI_UPLOAD_MAX_BYTES` (10 MB default) to prevent memory exhaustion.
- **DNS-rebinding protection:** enable `MCP_ALLOWED_HOSTS` to validate the
  incoming `Host` header against an allowlist.
- **Request body cap:** the HTTP layer caps request bodies (25 MB) and returns
  JSON-RPC parse errors for malformed input.
- **Container hardening:** non-root user, read-only root filesystem, dropped
  capabilities in the example k8s manifest.

---

## Local dev with the MCP Inspector

```bash
pnpm inspector   # runs: npx @modelcontextprotocol/inspector tsx src/index.ts
```

This launches the Inspector against the stdio transport. Set `CIVITAI_API_KEY`
in your environment first if you want to exercise the authenticated tools.

## Development

```bash
pnpm typecheck   # strict tsc, no emit
pnpm test        # vitest (no network - fetch is mocked)
pnpm build       # tsc to dist
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow.

## Non-goals

- No generation tools (generation lives elsewhere).
- No moderation actions.
- No model file downloads.

## License

[Apache-2.0](LICENSE).
