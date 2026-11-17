# Data model

PostgreSQL schema managed by Drizzle (`src/models/`, migrations in `sql/migrations/`). Amounts are `numeric(38,18)` so token quantities and USD values never lose precision.

```mermaid
erDiagram
  USERS ||--o{ TRADES : executes
  USERS ||--o{ POSITIONS : holds
  USERS ||--o{ PORTFOLIO_SNAPSHOTS : "has daily"
  USERS ||--o{ COMMENTS : writes
  USERS ||--o{ FOLLOWS : "follows (follower)"
  USERS ||--o{ FOLLOWS : "is followed (followee)"
  TOKENS ||--o{ TRADES : "traded in"
  TOKENS ||--o{ POSITIONS : "held as"
  TOKENS ||--o{ COMMENTS : "discussed in"

  USERS {
    uuid id PK
    text privy_did UK
    text wallet_address
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
  TRADES {
    uuid id PK
    uuid user_id FK
    text mint FK
    enum side "buy | sell"
    numeric token_amount
    numeric quote_amount_usd
    numeric price_usd
    numeric realized_pnl_usd
    text signature UK
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
    uuid followee_id PK
  }
```

## How a fill updates the tables

```mermaid
flowchart LR
  FILL[Confirmed swap<br/>Helius webhook] --> T[Insert trades row<br/>idempotent on signature]
  T --> P{Side}
  P -- buy --> B[positions: quantity += qty<br/>cost_basis += usd]
  P -- sell --> S[realized = usd - avg_cost × qty<br/>positions: quantity -= qty, cost_basis -= avg_cost × qty]
  S --> R[trades.realized_pnl_usd = realized]
  B --> LB[Redis ZINCRBY lb:window]
  R --> LB
  NIGHT[BullMQ portfolio-snapshot job] --> SNAP[portfolio_snapshots<br/>one row per user per day]
```

Redis holds derived, rebuildable state only: leaderboard sorted sets (`lb:24h`, `lb:7d`, `lb:30d`), WebSocket fan-out channels and BullMQ queues.
