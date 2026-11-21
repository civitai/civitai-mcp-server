# Civitai MCP Server

Turn your AI agent into a full Civitai participant.

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI
agents first-class access to Civitai: browse models, images, and creators; post
and publish work; react, review, follow, and collect; write articles and
comments; send and reply to direct messages; create and enter bounties; and
(for moderators) manage site announcements and the changelog; and report
Civitai developer-platform problems back to Civitai. Exposed over Streamable
HTTP or stdio; every tool is listed in the [tool catalog](#tool-catalog).

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

Set `CIVITAI_API_KEY` in your environment for every tool outside Browse (the
Browse tools work without it). The pulled script defaults to the server it came from;
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
`FORWARD_USER_BROWSING_LEVEL` requires a Cloudflare-fronted deployment.

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
| `CIVITAI_API_URL` | `https://civitai.red` | Base URL for **all** API calls (REST + tRPC). In-cluster override, e.g. `http://civitai-app:3000`. |
| `CIVITAI_WEB_URL` | the API site when that is public, otherwise `https://civitai.com` | Public website base for user-facing links in tool output (post/model/image/profile URLs). Distinct from `CIVITAI_API_URL`, which may point at an internal cluster service — links handed to users must stay public. Defaults to the API site when that is public (`https://civitai.com` or `https://civitai.red`), otherwise `https://civitai.com`. |
| `CIVITAI_API_KEY` | — | Bearer token for authenticated calls. Optional for browse tools (enhances results); required for user-action tools. In HTTP mode it is the fallback when a request omits an `Authorization` header. |
| `MCP_TRANSPORT` | `http` | `http` (Streamable HTTP) or `stdio` (local dev / desktop MCP clients). |
| `PORT` | `3100` | HTTP listen port (http transport only). |
| `PUBLIC_BASE_URL` | — | Optional canonical public base URL (e.g. `https://mcp.civitai.com`). When set, the advertised MCP endpoint in the landing page / `llms.txt` uses this instead of deriving it from the request `Host` header. Set it on the canonical hosted deployment so it always advertises its public address even behind proxies that don't forward `Host`/`X-Forwarded-*` reliably. Default: unset (Host-derived). |
| `OAUTH_ENABLED` | `false` | Gates one-click OAuth (RFC 9728 protected-resource metadata + the 401 `WWW-Authenticate` challenge). Off = token-only mode. Turn on only once Civitai's OAuth dynamic client registration is live. See [OAuth one-click connect](#oauth-one-click-connect-opt-in-off-by-default). |
| `FORWARD_USER_BROWSING_LEVEL` | `false` | When on, `search_models`, `search_images` and `get_image` use the calling user's own browsing level instead of the site default. Requires a Cloudflare-fronted deployment; see [Kubernetes](#kubernetes). |
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

## Tool catalog

Every tool returns both a compact human-readable text block and a
`structuredContent` JSON payload. Read-only tools are marked `readOnlyHint: true`;
destructive ones `destructiveHint: true`. Errors are normalized to
`{ ok: false, error, details? }` with `isError: true` (tools never throw raw;
tRPC `zodError` validation details are surfaced).

The tables below are generated from the tool registry
(`createServer(config).catalog`), the same list the landing page and `llms.txt`
render. Don't edit them by hand: change the tool registration, then run
`pnpm readme:catalog`. `pnpm test` fails when this section differs from the
registry.

<!-- BEGIN GENERATED TOOL CATALOG: edit the tool registrations, then run `pnpm readme:catalog` -->

55 tools in 15 categories. 7 work without an API key (Auth `public`); the rest need one (Auth `required`).

### Browse (no auth required)

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `search_models` | public | read-only | Search Civitai models (checkpoints, LoRAs, embeddings, etc). Returns names, base models, stats, trigger words, and AIR URNs for use with generation. Supports filtering by type, base model, tag, creator, and generation capability. Returns nextCursor for pagination. |
| `get_model` | public | read-only | Fetch full details for one or more models by ID (batch, concurrency 3): all versions, files, trigger words, and AIR URNs. |
| `get_model_version` | public | read-only | Fetch model version details by version ID (batch, concurrency 3): files, hashes, trigger words, and the AIR URN for generation. |
| `search_images` | public | read-only | Search Civitai images with full generation metadata (prompt, negative, sampler, steps, CFG, seed, resources). Filter by query, model, version, base model, creator, type. Returns nextCursor for pagination. |
| `get_image` | public | read-only | Fetch full generation metadata for image(s) by ID (batch, concurrency 3): prompt, negative prompt, sampler, steps, CFG, seed, and the resources used. There is no /images/:id endpoint upstream; this queries /images?imageId=<id>&withMeta=true. A new image stays hidden until its scan finishes: with your own API key, your own not-yet-scanned image is listed under `processing` instead of failing as not found. |
| `search_creators` | public | read-only | Search Civitai creators/users by name. Returns username and model count. |
| `list_enums` | public | read-only | List the Civitai API enum values usable for filtering (model types, sorts, base models, timeframes, etc). Use this to discover valid values before searching. |

### Posts

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `create_post` | required |  | Create a Civitai image post and attach images in order. This is the primary way to share creative work. Wraps the composite `post.createWithImages` endpoint in ONE atomic call: the server creates the post, attaches every image (in the given order), and optionally publishes — handling cleanup itself if any part fails. Each image is supplied by a pre-uploaded UUID or a URL (uploaded automatically first). Set publish=true to publish immediately (default false leaves it as a draft you can publish later with publish_post). New images are processing until their scan finishes and stay hidden until then (returned as processingImageIds); do not delete the post meanwhile. Requires an onboarded, non-muted account and the MediaWrite scope (a Full API key works). |
| `get_post` | required | read-only | Fetch a post by ID (wraps post.get): title, publishedAt, image count, author. |
| `publish_post` | required |  | Publish a draft post by setting publishedAt to now via post.update (with the required superjson Date hint). Idempotent-ish: re-publishing simply re-stamps publishedAt. Requires an onboarded account (post.update is verified). |
| `delete_post` | required | destructive | Delete a post you own (or any post, if moderator). Wraps post.delete. |

### Engagement

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `react` | required |  | Toggle a reaction (Like, Dislike, Laugh, Cry, Heart) on an image, post, article, comment, resourceReview, etc. Toggling the same reaction again removes it. Requires an onboarded, non-muted account (reaction.toggle is guarded). CAVEAT: this call is fire-and-forget server-side — it returns void and swallows errors, so a success here does NOT confirm the reaction landed. Re-read the entity to verify. `comment` here means a modern (commentV2) thread comment. |
| `upsert_resource_review` | required |  | Create or update your review of a model version: a numeric star rating (1-5), a recommend flag, and optional written details (Markdown, converted to the restricted review HTML). Uses resourceReview.upsert so re-reviewing edits your existing review instead of erroring. Requires an onboarded, non-muted account (guarded). |
| `get_my_resource_review` | required | read-only | Fetch your existing review for a model version (resourceReview.getUserResourceReview), or null. |
| `toggle_follow_user` | required |  | Toggle following a user (by numeric id or username). user.toggleFollow flips the follow state, so calling it again unfollows. Requires an onboarded account (verified). Pass a username and it is resolved to the numeric targetUserId first. |
| `toggle_favorite_model` | required |  | Add or remove a model from your favorites/bookmarks via user.toggleFavorite. Unlike most toggles this takes an explicit setTo flag (true = favorite, false = remove). This is the bookmark action; use notify_model for new-version notifications instead. Protected (no onboarding gate). |
| `notify_model` | required |  | Toggle the "notify me of new versions" engagement on a model via user.toggleNotifyModel. This is distinct from favoriting (use toggle_favorite_model to bookmark). Protected. |
| `toggle_bookmark_article` | required |  | Toggle bookmarking an article via user.toggleBookmarkedArticle (input { id }). Calling again removes the bookmark. Requires an onboarded account (verified). |
| `complete_onboarding_step` | required |  | Complete one onboarding step for the current account via user.completeOnboardingStep. A brand-new account cannot perform ANY verified/guarded social write (post, react, review, follow, etc.) until onboarding is finished, so this is a prerequisite. Steps: TOS, RedTOS, Profile (needs username+email), BrowsingLevels, Buzz (needs a recaptcha token, usually not completable headlessly). Run once per step. The Buzz step typically must be done in a real browser session. |

### Articles

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `upsert_article` | required |  | Create (omit id) or update (pass id) a Civitai article. Markdown content is converted to HTML server-side-safe. Optionally attach a cover by UUID (coverImageUuid) or by URL (coverImageUrl, uploaded automatically). Note: article.upsert requires title+content on every call. To flip publish state use publish_article. |
| `publish_article` | required |  | Publish a draft article. Fetches the current article, rebuilds the full upsert payload (so nothing regresses), and sets status=Published + publishedAt=now with the superjson Date hint required for the date to deserialize server-side. Idempotent: a no-op on already-published articles. |
| `unpublish_article` | required | destructive | Unpublish a published article via the dedicated article.unpublish endpoint. |
| `get_article` | required | read-only | Fetch an article by ID (wraps article.getById): title, status, publishedAt, tags, cover. |

### Comments

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `list_comments` | required | read-only | List the comments on an entity (model, image, post, article, review, bounty, etc.), or the replies to one comment (entityType=comment, entityId=the comment ID). Follows pagination so whole threads are returned, not just the first page, and nests replies up to `depth` levels. A single call shows at most 500 comments; past that the result is marked truncated. Bodies are truncated to 280 chars unless includeFull. Shows reaction counts and pin/hidden flags. |
| `get_comment` | required | read-only | Fetch a single comment with its full, uncapped body. commentv3 looks a comment up within the entity it is on, so pass that entity too: for a reply, the entity of the thread it is in (not the parent comment). On a model, an old comment ID from a link or notification also works. |
| `post_comment` | required |  | Post a comment on an entity, or reply to an existing comment (wraps commentv3.create). Always pass the entity the thread is on (entityType + entityId); to reply, also pass parentCommentId, and the reply goes into the parent's thread. Markdown is converted to the restricted comment HTML (p, br, strong, em, a). Needs an onboarded, non-muted account and the SocialWrite scope. |
| `edit_comment` | required |  | Edit a comment you wrote, or any comment as a moderator (wraps commentv3.update). Markdown is converted to the restricted comment HTML. Needs an onboarded, non-muted account and the SocialWrite scope. |
| `delete_comment` | required | destructive | Delete a comment you wrote, or any comment as a moderator (wraps commentv3.delete). A comment with replies stays as a [deleted] placeholder so its replies remain. Needs the SocialWrite scope. |
| `react_to_comment` | required |  | Toggle a reaction on a comment (Like, Dislike, Laugh, Cry, Heart). Toggling the same reaction again removes it. |
| `pin_comment` | required |  | Toggle the pinned state of a comment (wraps commentv3.togglePinned). Allowed for the owner of the entity the comment is on, and for moderators. Returns whether the comment is now pinned. Needs the SocialWrite scope. |
| `lock_thread` | required |  | Toggle the lock on an entity's whole comment section (wraps commentv3.toggleSectionLock); a locked section takes no new comments. Moderators only. Returns whether the section is now locked. |

### Collections

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `upsert_collection` | required |  | Create (omit id) or update (pass id) a collection via collection.upsert. Requires an onboarded, non-muted account (guarded). Flag-gated `collections` upstream — if the feature is disabled for the account the call errors with a feature/flag message rather than succeeding. |
| `add_to_collection` | required |  | Save a single item (one of an article, image, post, or model) into one or more collections via collection.saveItem. You must pass exactly one of articleId/imageId/postId/modelId, and at least one collectionId. Protected and flag-gated `collections` — a disabled flag errors out. To find your default bookmark collection id, list your collections first. |
| `follow_collection` | required |  | Follow a collection via collection.follow (use unfollow=true to unfollow). Protected and flag-gated `collections`. |

### Notifications

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `list_notifications` | required | read-only | List the current user's notifications (notification.getAllByUser). Filter to unread only and/or a category, and page with cursor (an ISO timestamp; the Date hint is applied automatically). Returns the items plus a nextCursor. |
| `mark_notifications_read` | required |  | Mark notifications as read (notification.markRead). Pass an id to clear one, all=true to clear everything, or a category to clear one bucket. The id is sent as a string because it is a bigint server-side. |
| `check_notifications` | required | read-only | Return the current user's unread notification count (user.checkNotifications). |

### Messaging

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `send_direct_message` | required |  | Send a direct message to a Civitai user (by numeric id or username). Chains user lookup -> chat.createChat -> chat.createMessage. Message is sent as Markdown; the server sanitizes it. |

### Chat

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `list_chats` | required | read-only | List the current user's chat conversations (chat.getAllByUser): chat id and the other participants. Use the chat id with get_chat_messages / reply_to_chat. |
| `get_chat_messages` | required | read-only | Read messages in a chat (chat.getInfiniteMessages), newest-first by default. Returns messages plus a nextCursor for older history. Use list_chats to find the chatId. |
| `reply_to_chat` | required |  | Send a message into an EXISTING chat thread (chat.createMessage). Content is sent as Markdown (server-sanitized) and is capped at 2000 characters. To start a NEW conversation use send_direct_message instead. Muted users can read but not send. |
| `mark_chat_read` | required |  | Mark a SINGLE chat conversation as read (chat.markChatRead) by advancing its lastViewedMessageId to the latest message. Use mark_all_chats_read to clear every conversation at once. |
| `mark_all_chats_read` | required |  | Mark ALL of your chats as read (chat.markAllAsRead). This is a blanket clear across every conversation. Use mark_chat_read to clear just one. |

### Bounties

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `create_bounty` | required |  | Create a bounty via bounty.create (NOT bounty.upsert — upsert is blocked for API keys). Requires an onboarded, non-muted account and the `bounties` feature flag. At least one example image is required (by UUID or URL). startsAt/expiresAt are dates (ISO strings here; the Date superjson hint is applied). Funding spends Buzz. |
| `update_bounty` | required |  | Update a bounty you own via bounty.update (owner-checked, guarded, `bounties` flag). Pass only the fields to change; startsAt/expiresAt and at least one image are still required by the schema, so include current images by UUID. |
| `create_bounty_entry` | required |  | Submit an entry to a bounty via the composite `bountyEntry.submit` endpoint (mutation/POST, guarded, `bounties` flag, BountiesWrite scope). Requires at least one deliverable file (a pre-uploaded file reference: { url, name, sizeKB }) and at least one example image (by UUID or URL — URLs are uploaded automatically to UUIDs). Files MUST already be uploaded; pass their refs. Pass id to edit an existing entry. |
| `award_bounty` | required |  | Award a bounty to a specific entry via bountyEntry.award { id }. Protected + `bounties` flag. Only the bounty owner may award; awarding distributes the bounty funds to the entry author. |

### Announcements (moderator)

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `upsert_announcement` | required |  | Create (omit id) or update (pass id) a homepage announcement banner. On update, missing fields are merged from the current row so required fields stay valid. startsAt defaults to now on create. Image can be a UUID or a URL (uploaded automatically). Moderator-only upstream. |
| `delete_announcement` | required | destructive | Permanently delete an announcement by ID. Moderator-only upstream. |
| `list_announcements` | required | read-only | List announcements. scope="current" returns currently-live ones (public endpoint); scope="all" returns the paginated moderator list. |

### Changelog (moderator)

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `upsert_changelog` | required |  | Create (omit id) or update (pass id) a /changelog entry. Markdown content is converted to HTML (same converter as articles). On create, title + content + type are required and effectiveAt defaults to now. On update, only the fields you pass are changed. Moderator-only, gated by the changelogEdit flag. |

### Images

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `upload_image` | required |  | Upload an image to Civitai from a URL or base64 data. Returns the image UUID (and probed dimensions) needed to set article covers and announcement images. Chains the presign + PUT upload internally. |

### Platform feedback

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `send_platform_feedback` | required |  | Tell Civitai that its developer platform got in your way: a bug, a confusing or missing piece, or a request, in the Civitai CLI, an SDK, the developer docs, app review, the sandbox, token scopes, or this MCP server. Use it when the problem is in Civitai's platform; do NOT use it for bugs in the app you are building, for feedback about a Civitai app or model, or for site support. Give a short message plus whatever structured detail you have (about, kind, a site key in `ref`, the command or tool, an HTTP status, an error excerpt, the docs URL). This server adds its own name and version. The text is sent to Civitai as given: do not paste secrets, tokens or personal data. Returns a ref; pass it to get_platform_feedback_status later to see whether Civitai acknowledged or fixed it. A matching earlier report is counted rather than duplicated. Needs a Civitai API key with the AppBlocksSubmit scope ("Manage your Apps"); a full-access personal API key works. |
| `get_platform_feedback_status` | required | read-only | Read back what Civitai did with platform feedback you sent with send_platform_feedback: received, acknowledged, fixed (with the version it shipped in), addressed, or not_planned, plus Civitai's public note and how many people reported it. Pass 1 to 50 refs exactly as send_platform_feedback returned them. A ref Civitai does not hold, or will not show you, comes back found: false. Needs a Civitai API key with the AppBlocksSubmit scope ("Manage your Apps"); a full-access personal API key works. |

### Utility

| Tool | Auth | Hints | Description |
|---|---|---|---|
| `whoami` | required | read-only | Resolve the current user from the active API key (id, username) and report authoritative account status via user.getSelfStatus (UserRead scope). Good smoke test for deployments and for confirming which account will perform user actions. Reports REAL onboarding state (isOnboarded + completedSteps), muted state, and an authoritative isModerator flag, plus subscription tier. An un-onboarded account fails every verified/guarded social write (post, react, review, follow) and a muted account fails guarded writes — so check this first if writes are 500ing, then call complete_onboarding_step. |

<!-- END GENERATED TOOL CATALOG -->

---

## Auth & scopes

- **API key:** create one at [civitai.com/user/account](https://civitai.com/user/account)
  and send it as `Authorization: Bearer <key>`. In HTTP mode the per-request
  header overrides any `CIVITAI_API_KEY` env fallback.
- **Browse without a key:** the Browse tools (the ones tagged `public` in the
  catalog above) call REST `/api/v1` and work unauthenticated (a key just
  enriches results). Every other tool, reads such as `get_post` and
  `get_article` included, goes through Civitai's tRPC API, which rejects
  anonymous callers with 401, so it needs a key.
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
  on). Browse tools stay anonymous; `initialize`, `tools/list`,
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
