# Community-Participation Gap Analysis

What the MCP server needs to add so an AI agent can be a **full participant** in the Civitai
community — doing what a normal signed-in human does on the site.

Source of truth: the Civitai app tRPC routers (`model-share/src/server/routers/`) and schemas
(`model-share/src/server/schema/`). Every procedure name + input shape below was read from those
files (file:line cited). REST endpoints live in `src/pages/api/v1/`.

> **Scope note.** Out of scope here (covered elsewhere or by PLAN.md): generation (civitai-gen),
> moderation actions (mod-actions), model file downloads, articles / comments / DMs / announcements /
> changelog / image upload / whoami (already in PLAN.md). This doc lists only the **gaps**.

---

## CRITICAL CROSS-CUTTING GOTCHAS (read before implementing any write tool)

### 1. The auth ladder — `protected` → `verified` → `guarded`
`model-share/src/server/trpc.ts:348-365`:
- `protectedProcedure` = authenticated (`isAuthed`).
- `verifiedProcedure` = protected **+ `isOnboarded`** (user must have completed onboarding).
- `guardedProcedure` = verified **+ `isMuted`** check (muted users blocked from social writes).

Implication: most community **write** actions are `guarded` or `verified`. If the API key belongs to
a user who hasn't finished onboarding, *every* `verified`/`guarded` write 500s with an onboarding
error. The MCP should expose **`complete_onboarding`** (see P0 #9) and surface a clear error pointing
to it. `whoami` should also report onboarding/muted state if available.

### 2. `blockApiKeys: true` — some actions are IMPOSSIBLE with an API key
`trpc.ts:170-182`: when a procedure sets `meta.blockApiKeys`, **any** API-key or OAuth-token request
is rejected with `FORBIDDEN` regardless of scope. Only browser-session auth passes. Confirmed on:
- `buzz.tipUser` (`buzz.router.ts:57`) — **tipping other users is blocked for API keys.**
- `bounty.upsert` (`bounty.router.ts:89`) — use `bounty.create` / `bounty.update` instead.
- `buzz.depositClubFunds` (`buzz.router.ts:75`).

The MCP authenticates with `CIVITAI_API_KEY` (a token), so these will 403. **Do not ship `tip_user`
as a working tool** — either omit it or have it return a clear "not available via API key" message.
Buzz *balance reads* are fine.

### 3. `requiredScope` token scopes
Every procedure declares `meta.requiredScope` (e.g. `TokenScope.SocialWrite`, `MediaWrite`,
`BountiesWrite`, `CollectionsWrite`, `BuzzRead`, `NotificationsRead`). A scoped token missing the
scope is denied (`trpc.ts:164-173`). A **Full** key passes everything. Document that the MCP needs a
Full key (or a key with the union of scopes the enabled tools require).

### 4. `isFlagProtected(...)` feature gates
Several routers wrap procedures in `isFlagProtected('bounties' | 'collections' | 'clubs' |
'buzz' | 'profileCollections' | ...)`. If the flag is off for the user/environment, the procedure
throws. Bounties and Collections are flag-gated end-to-end. Treat flag errors as "feature disabled,"
not a bug.

### 5. superjson Date hints (already in PLAN)
Same rule as articles: any `z.date()` input field (`post.create.publishedAt`,
`notification.getAllByUser.cursor`) needs the `meta.values: { field: ['Date'] }` superjson hint or it
silently lands as null/string server-side.

### 6. `bigint` in notifications
`notification.markRead.id` is `z.coerce.bigint()` (`notification.schema.ts:20`). JSON has no bigint;
send it as a string and let coerce handle it, and apply a superjson `['bigint']` hint if the tRPC
client wraps it.

---

## P0 — Essential for community participation

> **STATUS (Phase 2 shipped + composite-endpoint rewire):** All 9 P0 capability
> groups are implemented as MCP tools (53 tools total). Per-group tool names below.
> One procedure was confirmed `blockApiKeys:true` and deliberately NOT wrapped:
> `bounty.upsert` (we ship `bounty.create`/`bounty.update` instead). `buzz.tipUser`
> remains unshipped for the same reason (no tip tool).
>
> **Composite app endpoints (replace prior multi-call chains):**
> - `create_post` → `post.createWithImages` (ONE atomic call: create + ordered
>   images + optional publish; the server handles cleanup, so there is no more
>   client-side orphan-draft window). `publishedAt` returns as a Date.
> - `create_bounty_entry` → `bountyEntry.submit` ({ bountyId, files[{url,name,sizeKB,
>   unlockAmount?,currency?,benefactorsOnly?}], imageUuids[] }) — far simpler than the
>   old `bountyEntry.upsert` shape.
> - `mark_chat_read` → `chat.markChatRead { chatId }` (per-chat); the blanket
>   `chat.markAllAsRead` is now `mark_all_chats_read`.
> - `whoami` → `user.getSelfStatus` (GET) — FIXED: previously read `user.getById`
>   (simpleUserSelect), so its onboarding/muted/moderator fields were dead. Now it
>   surfaces authoritative `isOnboarded`, `completedSteps`, `muted`, `isModerator`,
>   and subscription `tier`. The old non-authoritative "Moderator Nameplate" cosmetic
>   heuristic was removed.
>
> | P0 group | Tools shipped |
> |---|---|
> | 1 Posts | `create_post` (`post.createWithImages`), `get_post`, `publish_post`, `delete_post` |
> | 2 Reactions | `react` |
> | 3 Resource reviews | `upsert_resource_review`, `get_my_resource_review` |
> | 4 Follow/favorite | `toggle_follow_user`, `toggle_favorite_model`, `notify_model`, `toggle_bookmark_article` |
> | 5 Collections | `upsert_collection`, `add_to_collection`, `follow_collection` |
> | 6 Notifications | `list_notifications`, `mark_notifications_read`, `check_notifications` (categories incl. Creator/Referral) |
> | 7 Chat read/reply | `list_chats`, `get_chat_messages`, `reply_to_chat`, `mark_chat_read` (per-chat), `mark_all_chats_read` (blanket) |
> | 8 Bounties | `create_bounty`, `update_bounty`, `create_bounty_entry` (`bountyEntry.submit`), `award_bounty` (NOT `bounty.upsert` — blockApiKeys) |
> | 9 Onboarding | `complete_onboarding_step` (+ `whoami` via `user.getSelfStatus`) |

### 1. Post creation & publishing (post.* / image.*)
**Why:** Posting images is *the* primary creative contribution on Civitai. Without this an agent can
generate images (civitai-gen) but can't share them. This is the single biggest gap.

**Procedures** (`post.router.ts`):
- `post.create` — `guardedProcedure`, scope `MediaWrite`. Input `postCreateSchema`
  (`post.schema.ts:52-61`): `{ modelVersionId?, title?, detail?, tag?, tags?, publishedAt? (Date),
  collectionId? }`. Returns the new post `{ id }`.
- `post.addImage` — `guardedProcedure`, `MediaWrite`. Input = `imageSchema.extend({ postId })`
  (`image.schema.ts:202-227` + `post.router.ts:119-122`): `{ url (uuid from image-upload, NOT http),
  postId, index, type, name?, width?, height?, hash?, meta?, modelVersionId?, mimeType?, ... }`.
  **`url` must be the upload UUID**, same rule as article covers.
- `post.update` — `verifiedProcedure`, `MediaWrite`. Input `postUpdateSchema` (`post.schema.ts:63-71`):
  `{ id, title?, detail?, publishedAt? (Date), collectionId?, collectionTagId? }`. **Setting
  `publishedAt` here is how you publish a post** (a draft has no publishedAt).
- `post.addTag` / `post.removeTag` (`post.router.ts:148-157`) — protected, `MediaWrite`.
- `post.reorderImages` (`reorderPostImagesSchema`, `post.schema.ts:133-137`).
- `post.get` / `post.getEdit` / `post.getInfinite` for reads.

**Auth:** create/addImage = guarded (onboarded + not muted); update = verified.

**Suggested MCP tools:**
- `create_post` — chains: `post.create` → for each image `post.addImage` (uploads via existing
  `upload_image` first to get UUID) → `post.update { publishedAt: now }` to publish. Single tool with
  `{ title?, detail?, modelVersionId?, tags?, images: [{url|data, meta?}], publish?: boolean }`.
  Mirror the article cover-upload chaining liberty already endorsed in PLAN.
- `update_post` / `publish_post` (thin wrapper that sets publishedAt) / `delete_post`.

**Gotcha:** ordering matters — image-upload → create post → addImage(postId) → publish. `publishedAt`
needs the `['Date']` superjson hint. NSFW level is derived server-side from image ingestion; the post
may sit "pending" until images finish scanning.

---

### 2. Reactions (reaction.toggle)
**Why:** Liking/hearting images, posts, articles, comments, reviews is the most common lightweight
community interaction. High value, trivial to implement.

**Procedure:** `reaction.toggle` — `guardedProcedure`, scope `SocialWrite`
(`reaction.router.ts:9-18`). Input `toggleReactionSchema` (`reaction.schema.ts:37-41`):
`{ entityId: number, entityType, reaction }`.
- `entityType` enum (`reaction.schema.ts:22-33`): `question, answer, comment, commentOld, image,
  post, resourceReview, article, bountyEntry, clubPost`.
- `reaction` enum = `ReviewReactions`: **Like, Dislike, Laugh, Cry, Heart**.

**Auth:** guarded. Rate-limited (`reactionRateLimits`, up to 60/min normal).

**Gotcha:** toggle semantics (calling again with same reaction removes it). The handler is
**fire-and-forget** — it returns void and swallows errors (`reaction.router.ts:14-17`). So a 200 does
**not** confirm success; the MCP can't read back the new state from this call. To verify, re-read the
entity. Note `comment` here = the modern commentV2 thread comment.

**MCP tool:** `react` — `{ entityType, entityId, reaction }`, `destructiveHint:false`. Describe the
toggle + fire-and-forget caveat.

---

### 3. Resource reviews / ratings (resourceReview.*)
**Why:** Reviewing models (star rating + recommend + written review) is a core trust signal a normal
user contributes. Directly shapes model reputation.

**Procedures** (`resourceReview.router.ts`):
- `resourceReview.create` — `guardedProcedure`, `SocialWrite`. Input `createResourceReviewSchema`
  (`resourceReview.schema.ts:67-77`): `{ modelId, modelVersionId, rating (number), recommended
  (boolean), details? (sanitized HTML) }`.
- `resourceReview.upsert` — guarded, `SocialWrite`, owner-checked. `upsertResourceReviewSchema`
  (`:54-65`): same + optional `id`.
- `resourceReview.update` (`:79-88`) / `resourceReview.delete` (owner-checked).
- Reads: `resourceReview.get`, `getUserResourceReview` (protected — "have I reviewed this?"),
  `getInfinite`, `getPaged`, `getRatingTotals`.

**Auth:** writes guarded; `getUserResourceReview` protected.

**Gotcha:** `details` runs through `sanitizedNullableString` allowing `div,strong,p,em,u,s,a,br,span,
code,pre` (`:61-64`) — reuse the comment markdown→HTML converter. `rating` is a raw number (typically
1–5). Prefer `upsert` so re-reviewing edits instead of erroring.

**MCP tool:** `review_resource` — `{ modelId, modelVersionId, rating, recommended, details? }` →
`resourceReview.upsert`. Plus `get_my_review` and `delete_review`.

---

### 4. Follow / favorite / engagement (user.* + model.*)
**Why:** Following creators and favoriting models is how a member builds a feed and signals support.
Core social-graph participation.

**Procedures** (`user.router.ts`):
- `user.toggleFollow` — `verifiedProcedure`, `SocialWrite`. Input `toggleFollowUserSchema`
  (`user.schema.ts:152-156`): `{ targetUserId: number, username? }`.
- `user.toggleFavorite` — protected, `SocialWrite`. `toggleFavoriteInput` (`user.schema.ts:139-143`):
  `{ modelId, modelVersionId?, setTo: boolean }` (favorite/bookmark a model).
- `user.toggleNotifyModel` — protected, `SocialWrite`. `toggleModelEngagementInput`
  (`user.schema.ts:146-149`): `{ modelId, type? (ModelEngagementType) }`.
- `user.toggleBookmarkedArticle` — verified, `SocialWrite`, `{ id }` (`user.router.ts:270-275`).
- `user.toggleArticleEngagement` — verified, `{ articleId, type }` (`user.schema.ts:201-204`).
- `user.toggleBountyEngagement` — verified, `{ bountyId, type (BountyEngagementType) }`
  (`user.schema.ts:211-214`).
- Reads: `user.getFollowingUsers`, `user.getEngagedModels`, `user.getBookmarkedModels`,
  `user.getBookmarkedArticles`, `user.getArticleEngagement`, `user.getBountyEngagement`.

**Auth:** toggleFollow/article = verified (onboarded); toggleFavorite/notify = protected.

**Gotcha:** these are toggles (state flips) except `toggleFavorite` which takes an explicit `setTo`.
For follow you must pass the numeric `targetUserId` — resolve username→id first (reuse the existing
user-lookup helper from PLAN).

**MCP tools:** `follow_user {user, unfollow?}`, `favorite_model {modelId, on}`,
`bookmark_article {articleId}`, `notify_model {modelId, type?}`. Plus `list_following`,
`list_favorited_models`.

---

### 5. Collections (collection.*)
**Why:** Collections are how members curate and save content (images, models, posts, articles) and
follow curated sets — a major organizing/participation surface. Flag-gated (`collections`).

**Procedures** (`collection.router.ts`):
- `collection.upsert` — `guardedProcedure`, `CollectionsWrite`. `upsertCollectionInput`
  (`collection.schema.ts:166-182`): `{ id?, name (≤30), description? (≤300), type
  (CollectionType, default Model), read?, write?, nsfw?, image?, imageId?, tags?, ...item fields }`.
- `collection.saveItem` — protected, `CollectionsWrite`. `saveCollectionItemInputSchema`
  (`collection.schema.ts:34-46` + base `:24-31`): `{ type?, articleId?|imageId?|postId?|modelId?
  (exactly one), note?, collections: [{collectionId, tagId?, ...}], removeFromCollectionIds? }`.
- `collection.bulkSaveItems` (`:143`), `collection.removeFromCollection` (`:158`).
- `collection.follow` / `collection.unfollow` — protected, `{ collectionId, userId? }`
  (`followCollectionInputSchema`, `collection.schema.ts:202-205`).
- `collection.delete`, `collection.updateCoverImage`, `collection.getEntryCount`.
- Reads: `collection.getInfinite`, `getById`, `getAllUser`, `getAllCollectionItems`.

**Auth:** upsert = guarded; saveItem/follow = protected. **All flag-gated `collections` /
`profileCollections`.**

**Gotcha:** `saveItem` requires **exactly one** of articleId/imageId/postId/modelId (refined in
schema) and a `collections[]` array (you save *into* one or more collections at once). To save to a
user's default bookmark collection, list it via `user.getBookmarkCollections` first.

**MCP tools:** `create_collection`, `save_to_collection {itemType, itemId, collectionIds[], note?}`,
`follow_collection {collectionId}`, `list_my_collections`, `list_collection_items {collectionId}`.

---

### 6. Notifications (notification.* + user.checkNotifications)
**Why:** Reading and clearing your own notifications is basic account hygiene and lets an agent react
to replies, follows, mentions, etc. Closes the feedback loop on everything else it does.

**Procedures** (`notification.router.ts`):
- `notification.getAllByUser` — protected, scope `NotificationsRead`. Input
  `getUserNotificationsSchema.partial()` (`notification.schema.ts:6-10`): `{ cursor: Date, unread?,
  category? (NotificationCategory), limit? }`.
- `notification.markRead` — protected, `NotificationsWrite`. `markReadNotificationInput`
  (`notification.schema.ts:19-23`): `{ id? (bigint), all?, category? }`.
- `notification.updateUserSettings` — protected. `{ toggle, type[] }` (`:13-16`).
- `user.checkNotifications` (`user.router.ts:178`) — quick unread count.

**Auth:** all protected (no onboarding gate).

**Gotcha:** `cursor` is `z.date()` → needs `['Date']` superjson hint. `id` is `z.coerce.bigint()` →
pass as string (see cross-cutting #6). `markRead { all: true }` clears everything; `{ category }`
clears one bucket.

**MCP tools:** `list_notifications {unread?, category?, limit?}`, `mark_notifications_read {id?|all?|
category?}`, `check_notifications` (count).

---

### 7. Chat reading & replying (chat.*)
**Why:** PLAN.md only creates a *new* DM (createChat→createMessage). A real participant must **read
existing conversations and reply** — list chats, read history, post into an existing thread, mark
read. This is the conversational half that's missing.

**Procedures** (`chat.router.ts`):
- `chat.getAllByUser` — protected, `UserRead`. Lists the user's chats.
- `chat.getInfiniteMessages` — protected, `UserRead`. `getInfiniteMessagesInput`
  (`chat.schema.ts:40-48`): `{ chatId, sortDirection?, limit? (default 1000), cursor? }`.
- `chat.createMessage` — protected, `SocialWrite`. `createMessageInput` (`chat.schema.ts:25-31`):
  `{ chatId, content (1–2000), contentType? (default Markdown), referenceMessageId? }`.
- `chat.markAllAsRead` (`:48`), `chat.modifyUser` (set `lastViewedMessageId` per chat,
  `chat.schema.ts:16-23`), `chat.getUnreadCount`, `chat.getUserSettings/setUserSettings`.
- `chat.createChat` — guarded, `{ userIds: number[] }` (already used by PLAN's DM tool).

**Auth:** reads protected; createMessage protected; createChat guarded.

**Gotcha:** `createMessage` content is capped at **2000 chars**. Marking read is per-member via
`modifyUser { chatMemberId, lastViewedMessageId }`, or blanket `markAllAsRead`. To find the
`chatMemberId` you must read the chat object from `getAllByUser`. Note muted users can read but not
send (router comment line 26).

**MCP tools:** `list_chats`, `read_chat {chatId, limit?}`, `reply_to_chat {chatId, content,
referenceMessageId?}`, `mark_chat_read {chatId | all}`. Extend the existing DM tool family.

---

### 8. Bounties — browse / create / enter / award (bounty.* + bountyEntry.*)
**Why:** Bounties are a core economic-participation loop: post a request, submit entries, award
winners. A member can create, fund, enter, and award. Flag-gated (`bounties`).

**Procedures:**
- `bounty.getInfinite` / `getById` / `getEntries` / `getBenefactors` — public reads
  (`bounty.router.ts:57-76`).
- `bounty.create` — `guardedProcedure`, `BountiesWrite`. `createBountyInputSchema`
  (`bounty.schema.ts:52-88`): `{ name, description, unitAmount, ... }` (dates, type, files, etc.).
- `bounty.update` — guarded, owner-checked (`bounty.router.ts:82`).
- `bounty.addBenefactorUnitAmount` — protected, `BountiesWrite` (`:100`) — add buzz to a bounty.
- `bountyEntry.upsert` — `guardedProcedure`, `BountiesWrite`. `upsertBountyEntryInputSchema`
  (`bounty-entry.schema.ts:22-…`): `{ id?, bountyId, files[] (min 1), ... }` — **submit an entry**.
- `bountyEntry.award` — protected, `BountiesWrite`, `{ id }` (`bountyEntry.router.ts:61`) — award a
  bounty to an entry.
- `bountyEntry.getById` / `getFiles`.

**Auth:** create/upsertEntry = guarded; award/addBenefactor = protected. All flag-gated `bounties`.

**Gotcha:** **`bounty.upsert` is `blockApiKeys:true`** (`bounty.router.ts:89`) — do NOT use it; use
`create`/`update`. `bounty.create` dates are `z.string()` in upsert but check create schema; entries
require ≥1 file (an uploaded image/model file). Adding benefactor funds spends buzz.

**MCP tools:** `search_bounties`, `get_bounty {id}`, `create_bounty {...}`, `enter_bounty {bountyId,
files[]}` → `bountyEntry.upsert`, `award_bounty_entry {entryId}`. Priority note: reads are P0-easy;
create/enter/award are P1 if file-upload plumbing is heavy.

---

### 9. Onboarding (user.completeOnboardingStep)
**Why:** A brand-new agent account cannot perform any `verified`/`guarded` action until onboarding is
complete. This is a prerequisite tool, not a feature — without it the whole write surface can be dead.

**Procedure:** `user.completeOnboardingStep` — protected, `UserWrite`. Input `userOnboardingSchema`
(`user.schema.ts:317-…`), a discriminated union on `step`: `TOS`, `RedTOS`, `Profile {username,
email}`, `BrowsingLevels`, etc.

**Gotcha:** discriminated union — send the right `step` literal + its fields. The `Profile` step sets
username/email. Run once per step. Pair with `user.usernameAvailable` to pick a username.

**MCP tool:** `complete_onboarding {step, username?, email?}` (advanced/utility). At minimum,
`whoami` should detect the un-onboarded state and tell the agent to call this.

---

## P1 — Valuable

### 10. Reading comment threads (commentv2.*) — partial gap
PLAN's comment tools cover post/read/react. Confirm they use **commentv2** for the modern entity
threads. Reads worth surfacing explicitly:
- `commentv2.getThreadDetails` (`commentv2.router.ts:73`) — full thread (locked state, root comment).
- `commentv2.getInfinite` (`:77`) — paged comments by `commentConnectorSchema`.
- `commentv2.getCount` (`:54`), `commentv2.getSingle` (`:58`).
- `commentv2.toggleHide` — protected, `{ ... }` (`toggleHideCommentSchema`) — hide a comment on your
  own content (non-mod). Worth exposing as a user action.
- `commentv2.upsert` (guarded, rate-limited) is the write path PLAN already wraps.

(`comment.router.ts` is the **legacy v1** model-comment surface — entityType `model`/`review`/
`question`/`answer`. Keep PLAN's existing entity-type map which spans both.)

### 11. Hide / block preferences (hidden-preferences.* + user tag prefs)
**Why:** Curating one's own feed (hide users, tags, images, models; block users) is normal
participation.
- `hiddenPreferences.toggleHidden` — protected, `UserWrite`. `toggleHiddenSchema`
  (`user-preferences.schema.ts:4-30`): discriminated union `kind: 'tag'|'user'|'image'|'model'|
  'blockedUser'`, `data[]`, `hidden?`. `tag` accepts multiple; others max 1.
- `hiddenPreferences.getHidden` — public, returns all hidden prefs for the user.
- Related: `user.getTags`, blocked-tags helpers in `user.schema.ts:161-164`.

**MCP tools:** `hide {kind, id, name?, hidden?}`, `block_user {userId}`, `list_hidden`.

### 12. Profile / account self-management (user.update, user-profile.*)
**Why:** Updating one's own bio, links, cosmetics, settings, browsing mode is normal account upkeep.
- `user.update` — guarded, `UserWrite`. `userUpdateSchema` (bio, image, settings, etc.).
- `user.updateBrowsingMode` — guarded, `UserWrite` (sets NSFW browsing levels — affects what the
  agent can even see/fetch).
- `user.setSettings` / `user.getSettings`, `user.updateContentSettings`.
- `user.equipCosmetic` / `claimCosmetic` / `getCosmetics`.
- `userProfileRouter` (`user-profile.router.ts`) — richer profile section management.
- `userLinkRouter` (`user-link.router.ts`) — social links on profile.

**MCP tools:** `update_profile {...}`, `set_browsing_mode {nsfwLevels}`, `get_my_settings`.
**Gotcha:** `updateBrowsingMode` calls `refreshSession` — the agent's NSFW visibility changes after.

### 13. Buzz balance & transaction reads (buzz.*)
**Why:** Knowing your buzz balance is needed before spending (bounties, tips, generation). Reads only.
- `buzz.getUserAccount` / `buzz.getBuzzAccount` — protected (flag `buzz`), `BuzzRead` — **balance**.
- `buzz.getUserTransactions` / `buzz.getAccountTransactions` — history.
- `buzz.getUserMultipliers`, `buzz.getEarnPotential`.

**MCP tool:** `get_buzz_balance`, `list_buzz_transactions`.
**Gotcha:** **`buzz.tipUser` is `blockApiKeys:true`** — tipping via API key is impossible (see
cross-cutting #2). Expose balance/history only; do not ship a working tip tool.

### 14. Reporting content (report.create)
**Why:** Flagging TOS/NSFW/spam/ownership violations is a normal community-safety action (distinct
from *moderation* — any user can file a report).
- `report.create` — `guardedProcedure`, `SocialWrite`. `createReportInputSchema`
  (`report.schema.ts`) — discriminated on `reason`: `NSFW, TOSViolation, Ownership, Claim,
  AdminAttention, CSAM, Spam`, each with a `details` shape and an entity reference.
- `report.createAppeal` — guarded — appeal a moderation action on your own content.
- `report.getRecentAppeals` / `getAppealDetails` — protected reads.

**MCP tools:** `report_content {entityType, entityId, reason, details}`, `appeal_moderation {...}`.

### 15. Leaderboards & creator discovery (user.getLeaderboard, leaderboard.*)
**Why:** Seeing standings / discovering top creators is normal browsing.
- `user.getLeaderboard` — public, `getAllQuerySchema` (`user.router.ts:170-173`).
- `leaderboard.router.ts` — full leaderboard listing endpoints.
- `user.getCreators` / `user.getCreator` / `user.getById` for profile reads (some in PLAN's browse).

**MCP tool:** `get_leaderboard {type?, page?}`, `get_user_profile {user}`.

---

## P2 — Nice-to-have / skip

- **Clubs** (`club.*`, `clubMembership.*`, `clubPost.*`, `clubAdmin.*`) — membership/club posts.
  Heavy surface, niche, often disabled by `clubs` flag. Skip unless a club use-case appears.
- **Questions & Answers** (`question.router.ts`, `answer.router.ts`) — legacy Q&A; low traffic.
- **Challenges / daily challenge** (`challenge.router.ts`, `daily-challenge.router.ts`) — entering
  contests; mostly collection-backed (covered via collections) and partly mod-gated.
- **Entity collaborators** (`entity-collaborator.router.ts`) — invite co-authors on posts/articles.
- **Vault** (`vault.router.ts`) — paid storage; subscription-gated.
- **Cosmetic shop / purchasable rewards / redeemable codes** (`cosmetic-shop.*`,
  `purchasable-reward.*`, `redeemableCode.*`) — buzz-spending / `blockApiKeys`-prone; low community
  value for an agent.
- **Comics / build-guide / wildcard-set / generation-preset / technique / tool** — content-authoring
  niches; revisit only if a specific need arises.
- **Auctions / donation goals / creator program / referral / subscriptions / payments**
  (`auction.*`, `donation-goal.*`, `creator-program.*`, `referral.*`, `stripe.*`, `paddle.*`, etc.)
  — economic/account plumbing, mostly out of "community participation," much of it `blockApiKeys` or
  `Full` scope. Skip.
- **Model publishing/management** (`model.*`, `model-version.*`, `model-file.*`, `training.*`) —
  explicitly deprioritized in the brief. Big surface; out of scope for "participate like a normal
  member who posts images and engages." Flag for a future phase if agents need to publish models.

---

## Implementation ordering recommendation

1. **P0 #6 Notifications** + **#2 Reactions** + **#3 Reviews** + **#4 Follow/Favorite** — small,
   high-value, mostly single-call toggles. Fast wins.
2. **P0 #7 Chat read/reply** — extends the DM family already in PLAN.
3. **P0 #1 Post creation** — the flagship gap; reuse the image-upload chaining liberty. Do this once
   the upload tool from PLAN is solid.
4. **P0 #5 Collections** + **#8 Bounties (reads first, writes later)**.
5. **P0 #9 Onboarding** + **whoami onboarding/muted detection** — wire early so write tools fail
   gracefully with actionable errors.
6. P1 batch (hide/block, profile, buzz reads, reporting, leaderboards).

## Capability count

- **P0:** 9 capability groups (post creation, reactions, resource reviews, follow/favorite,
  collections, notifications, chat read/reply, bounties, onboarding).
- **P1:** 6 capability groups (commentv2 reads, hide/block, profile self-mgmt, buzz reads, reporting,
  leaderboards).
- **P2 / skip:** ~12 router families flagged (clubs, Q&A, challenges, collaborators, vault, shop,
  comics, auctions/economic, model publishing, etc.).

**Total new community-participation capabilities identified: 15 actionable (9 P0 + 6 P1), plus ~12
deliberately deprioritized.**
