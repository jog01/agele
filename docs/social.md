# PostgreSQL social store

Social routes use the same tables, repository, and auth path in demo and live.
In the default `MARKET_DATA_PROVIDER=mock` mode the API runs an idempotent seed
step before listening. Run `bun run db:migrate` first. The seed adds 12 fictional
traders, follows, versioned theses, replies and reactions, and records dated
buys and sells via `PgTradeRepository.record`, including both open and closed
positions. Its timestamps are anchored to the first seed, not shifted on every
read or restart. Set `MARKET_DATA_PROVIDER=live` and use a separate unseeded
database for a live-only deployment. The live API and worker refuse startup if
PostgreSQL contains demo users or seeded trade signatures; no rows are erased.
Writes always use verified Privy identity; the seeded accounts are not login identities.

```mermaid
erDiagram
    USERS ||--o{ FOLLOWS : follows
    USERS ||--o{ TRADES : fills
    USERS ||--o{ POSITIONS : holds
    USERS ||--o{ THESES : owns
    TOKENS ||--o{ TRADES : traded
    TOKENS ||--o{ COMMENTS : discussed
    TRADES ||--o{ THESES : first_buy
    THESES o|--o{ COMMENTS : versions_and_replies
    COMMENTS o|--o{ COMMENTS : parent_post
    COMMENTS ||--o{ SOCIAL_REACTIONS : receives
    USERS ||--o{ SOCIAL_REACTIONS : likes
    TOKENS ||--o{ FEED_DISCUSSIONS : anchors
    FEED_DISCUSSIONS o|--o{ COMMENTS : replies
    FEED_DISCUSSIONS ||--o{ FEED_REACTIONS : receives
    USERS ||--o{ FEED_REACTIONS : likes
```

```mermaid
sequenceDiagram
    participant W as Client
    participant A as Hono API
    participant S as SocialService
    participant DB as PostgreSQL
    W->>A: GET /v1/feed or token discussion
    A->>A: Validate cursor, verify optional bearer token
    A->>S: Global or following query
    S->>DB: Read matched trades and thesis versions by descending second and UUID
    DB-->>S: Candidate events
    S->>S: Resolve position episodes, enrich prices, apply filters
    S-->>A: Page and nextCursor
    A-->>W: Social activity
    W->>A: POST thesis version or comment (bearer)
    A->>S: Verified author and validated content
    S->>S: Text moderation; validate position window or same-token parent
    S->>DB: Lock writer, check rate, save discussion
    A-->>W: Stored post with provenance and engagement
    W->>A: GET or POST /v1/feed/{key}/comments; PUT or DELETE /v1/feed/{key}/reaction
    A->>S: Card key and optional viewer for reads; verified viewer for writes
    S->>DB: Resolve card from its indexed activity
    S->>DB: Read replies, or lazily anchor and write engagement
```

- Follow targets are wallet addresses, including not-yet-registered wallets.
  Following feed resolves canonical and linked Solana wallet aliases. Follow
  mutations are idempotent; a user may follow 10 new wallets per minute and
  must have three trades before following more than 100 wallets.
- A position is a continuous run from its first buy until its holdings return
  to zero. A thesis identity is unique by wallet, mint, and first buy ID.
  `POST /v1/tokens/{mint}/theses` accepts up to 3,000 characters and an optional
  position ID; if omitted, the most recent position is selected. It creates a
  new immutable version while the position is open or up to three hours after
  closing. If no position exists the API returns 404; an expired window is 409.
- `GET /v1/tokens/{mint}/theses/{thesisId}` lists versions and nested replies
  newest first, and returns any pinned version separately. Only the author can
  pin or unpin a version. Replies use `parentId` and cannot cross token threads.
  Token comments have a 200-character limit. `PUT/DELETE /v1/posts/{id}/reaction`
  sets/removes a like, with one like per viewer and post.
- The text moderation hook rejects external chat invites by default, and the
  database rejects repeated text in a one-minute window and allows up to five
  posts per minute per author. The hook is injectable for additional moderation;
  no third-party or AI moderation service is configured by default.
- All feed cards expose `likeCount`, `replyCount` (including nested replies),
  and `viewerLiked` (false for anonymous viewers). Thesis cards retain their
  existing thread and reaction routes and their `likes`/`likedByMe` fields.
  For other cards use the opaque `discussionKey`: read or post replies at
  `/v1/feed/{key}/comments`, and like or unlike with
  `PUT/DELETE /v1/feed/{key}/reaction`. Parents must be in the same thread.
  Bought, sold, and closed cards attach to the underlying fill; a milestone
  for that fill has its own thread. A multi-user card shares a thread across
  global and following views for the same token, side, and UTC bucket.
- Feed and discussion rows carry `source`; profile and history responses use
  `X-Data-Source`. Seeded leaderboard entries carry `source: demo`. In the
  absence of the webhook/Redis projection, ranking reads derive results from
  PostgreSQL trades and positions using the same window calculations.
- `GET /v1/feed` defaults to trades and theses. `eventType` distinguishes
  bought, sold, closed, thesis, milestone, multi-user, and new-trader activity.
  Use the comma-separated `types` filter to select variants, including the
  opt-in derived cards: realized profit of at least $1,000 on a sell, two or
  more distinct traders on the same token and side in a completed five-minute
  UTC bucket, or a trader's first indexed fill. Reuse the same filters with
  each cursor. Size applies to signed-side USD volume, portfolio size to the
  trader's currently priced holdings (the representative trader on a group
  card), and cap and change since a position's first buy use current market
  data. Missing prices are excluded when a matching price filter is requested.
- `GET /v1/traders/{wallet}/positions/{mint}` returns chronological fills,
  average entry, and realized/unrealized PnL for the most recent position or
  a specified `positionId`. The profile includes joined date, trade count,
  average hold across closed positions and, for signed-in viewers, mutual
  followers (people the viewer follows who follow this trader). The
  `followers` and `following` routes are individually paginated. The public
  `portfolio/history` route reads stored position-value snapshots, excluding
  cash and linked-wallet balances. Legacy equity-only snapshots are omitted.
