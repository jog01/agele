# Data model

PostgreSQL schema managed by Drizzle (`src/models/`, migrations in `sql/migrations/`). Amounts are `numeric(38,18)` so token quantities and USD values never lose precision.

```mermaid
erDiagram
  USERS ||--o{ TRADES : executes
  USERS ||--o{ WALLETS : owns
  USERS ||--o{ POSITIONS : holds
  USERS ||--o{ PORTFOLIO_SNAPSHOTS : "has daily"
  USERS ||--o{ COMMENTS : writes
  USERS ||--o{ FOLLOWS : "follows (follower)"
  TOKENS ||--o{ TRADES : "traded in"
  TOKENS ||--o{ POSITIONS : "held as"
  TOKENS ||--o{ COMMENTS : "discussed in"

  USERS {
    uuid id PK
    text privy_did UK
    text wallet_address UK "nullable primary wallet address"
    text handle
    text display_name
    text avatar_url
  }
  TOKENS {
    text mint PK
    text symbol
    text name
    int decimals
    text image_url
  }
  WALLETS {
    uuid id PK
    uuid user_id FK
    text address UK
    text chain_type
    text wallet_client_type
    text privy_wallet_id "nullable"
    boolean is_primary
    timestamptz created_at
    timestamptz updated_at
  }
  TRADES {
    uuid id PK
    uuid user_id FK
    text mint FK
    enum side "buy | sell"
    numeric token_amount
    numeric quote_amount_usd
    numeric price_usd
    numeric realized_pnl_usd
    text signature "unique together with user_id"
    timestamptz executed_at
  }
  POSITIONS {
    uuid user_id PK
    text mint PK
    numeric quantity
    numeric cost_basis_usd
    numeric realized_pnl_usd
  }
  PORTFOLIO_SNAPSHOTS {
    uuid user_id PK
    date day PK
    numeric value_usd
  }
  COMMENTS {
    uuid id PK
    uuid user_id FK
    text mint FK
    text body
  }
  FOLLOWS {
    uuid follower_id PK
    text followee_wallet PK "Solana address, not a user FK"
    timestamptz created_at
  }
```

## How a fill updates the tables

```mermaid
flowchart LR
  FILL[Confirmed swap<br/>Helius webhook] --> T[Insert trades row<br/>idempotent on signature + userId]
  T --> P{Side}
  P -- buy --> B[positions: quantity += qty<br/>cost_basis += usd]
  P -- sell --> S[Clamp sold quantity to owned quantity<br/>realized = prorated proceeds minus basis]
  S --> R[trades.realized_pnl_usd = realized]
  B --> LB[Recompute user from Postgres<br/>Redis ZADD leaderboard:window + HSET stats]
  R --> LB
  NIGHT[BullMQ portfolio-snapshot job] --> SNAP[portfolio_snapshots<br/>one row per user per day]
```

Redis holds derived, rebuildable leaderboard state and BullMQ queues. For each
`w` in `24h|7d|30d`, `leaderboard:<w>` is a ZSET (member `userId`, score `pnlUsd`)
and `leaderboard:<w>:stats` is a hash (`userId` → JSON `{volumeUsd,trades,winRatePct,pnlPct}`).
Updates are absolute recomputations, not increments, so retries cannot double-count.
Full rebuild uses one MULTI to delete/repopulate all window keys, including empty
windows. The current WS fan-out is local to the API process, not Redis pub/sub.

`trades` has composite uniqueness `(signature,user_id)` so one Solana transaction
can index different linked users. Positions remain per user/mint. Decimal arithmetic
for persisted trade/position updates uses 18-place bigint fixed point; API/derived
rank values are JSON numbers. `portfolio_snapshots` is keyed by `(user_id,day)`;
today's sweep is an upsert, not an accumulating series.

## Wallet follows and feed

`follows` has a composite primary key `(follower_id, followee_wallet)` and an index on `followee_wallet`. The follower references `users.id` with cascade deletion; the target need not be registered. Existing user-target follows migrate to the target's primary `wallet_address`; targets without a primary wallet cannot be represented and are omitted. PUT and DELETE are idempotent. Following any of the viewer's stored wallets is rejected.

```mermaid
sequenceDiagram
  participant API
  participant Users
  participant Follows as FollowRepository
  participant Social as SocialProvider
  API->>Users: ensureUser(verified claims)
  Users-->>API: viewer + owned wallets
  API->>Follows: follow(viewer.id, target wallet)
  Note over Follows: PK prevents duplicates; no target user FK
  API->>Follows: listWallets(viewer.id)
  Follows-->>API: followed wallet addresses
  API->>Social: feed(wallets, cursor, limit)
  Social-->>API: items + nextCursor
```

The [social store](social.md) reads stored trades and thesis versions. The cursor encodes `(createdAt, id)` in base64url; both keys sort descending, with an exclusive boundary. Timestamps are integer Unix seconds. Anonymous leaderboard entries omit `isFollowing`; verified viewers receive a boolean per wallet.
