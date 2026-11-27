# PostgreSQL social store

Social routes use the same tables, repository, and auth path in demo and live.
In the default `MARKET_DATA_PROVIDER=mock` mode the API runs an idempotent seed
step before listening. Run `bun run db:migrate` first. The seed adds 12 fictional
traders, follows, versioned theses, replies and reactions, and records dated
buys and sells via `PgTradeRepository.record`, including both open and closed
positions. Its timestamps are anchored to the first seed, not shifted on every
read or restart. Set `MARKET_DATA_PROVIDER=live` and use a separate unseeded
database for a live-only deployment; existing seed rows are not erased. Writes
always use verified Privy identity; the seeded accounts are not login identities.

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
    DB-->>W: via API: page and nextCursor
    W->>A: POST thesis version or comment (bearer)
    A->>S: Verified author and validated content
    S->>S: Text moderation; validate position window or same-token parent
    S->>DB: Lock writer, check rate, save discussion
    A-->>W: Stored post with provenance and engagement
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
- Feed and discussion rows carry `source`; profile and history responses use
  `X-Data-Source`. Seeded leaderboard entries carry `source: demo`. In the
  absence of the webhook/Redis projection, ranking reads derive results from
  PostgreSQL trades and positions using the same window calculations.
