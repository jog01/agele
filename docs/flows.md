# Flows

## Sign-in and wallet

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web (Privy SDK)
  participant P as Privy
  participant A as API
  U->>W: Sign in (email / Google)
  W->>P: Auth
  P-->>W: Access token + embedded Solana wallet
  W->>A: GET /v1/me (Bearer token)
  alt No PRIVY_APP_ID
    A-->>W: 503 auth_not_configured
  else Auth configured
    A->>A: verifyAccessToken (pinned key or JWKS)
    alt Invalid or expired token
      A-->>W: 401
    else Valid token
      A->>A: Upsert user by Privy DID
      opt walletAddress is null
        alt No PRIVY_APP_SECRET
          Note over A: Wallet linkage disabled; use stored wallets
        else Linkage enabled
          A->>P: Privy API users()._get(did)
          alt Privy lookup succeeds
            P-->>A: Linked accounts
            A->>A: Upsert Solana wallets; skip addresses owned by others
            A->>A: Set first stored embedded wallet as primary + walletAddress
          else Privy lookup fails
            Note over A: Warn; use stored wallets, walletAddress stays null
          end
        end
      end
      A-->>W: Profile + stored wallets
    end
  end
```

Signed-out users can browse every market; sign-in only gates trading, posting and following. Without `NEXT_PUBLIC_PRIVY_APP_ID` the web app runs in demo mode with sign-in disabled.

## Trade (quote, review, sign, receipt)

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web
  participant A as API (SwapService)
  participant S as FeeSponsor
  participant J as Jupiter Swap V2
  U->>W: Enter amount, Review
  W->>A: GET /v1/swaps/quote (mints, base-unit amount)
  A->>J: order (no taker, no transaction)
  J-->>A: Preview quote
  A-->>W: Preview: receive, min receive, fees, impact
  W->>A: POST /v1/swaps (authenticated)
  A->>J: order (linked user wallet, our fee payer)
  J-->>A: Unsigned tx + quote
  A->>A: Validate mints, amount, taker, payer fields, caps
  A->>S: register (validate, simulate, quotas, issued record)
  S-->>A: expiresAt
  A->>A: Persist issued swap
  A-->>W: requestId, transaction, expiresAt + quote fields
  W->>U: Review dialog (explicit, no silent signing)
  U->>W: Confirm
  W->>W: Privy wallet signs
  W->>A: POST /v1/swaps/:id/submit (user-signed tx)
  A->>S: cosign (validate + simulate + quota)
  S-->>A: Fee-payer signature
  A->>J: execute
  J-->>A: Success / Failed + signature and actual amounts
  A->>A: Persist confirmed / failed (ambiguous = submitted)
  A-->>W: Receipt (confirmed / failed / submitted)
  W->>A: GET /v1/swaps/:requestId (authenticated owner only)
  A-->>W: Persisted status and amounts
```

### Trade states

```mermaid
stateDiagram-v2
  [*] --> Editing
  Editing --> Quoting: Review
  Quoting --> Reviewing: quote ok
  Quoting --> Editing: quote failed
  Reviewing --> Editing: Back / quote expired
  Reviewing --> Signing: Confirm
  Signing --> Editing: user rejected
  Signing --> Submitting: signed
  Submitting --> Confirmed: Jupiter Success
  Submitting --> Pending: ambiguous / timeout
  Submitting --> Failed: sponsor or Jupiter rejected
  Pending --> Confirmed: Helius webhook
  Pending --> Failed: expired / dropped
  Confirmed --> [*]
  Failed --> Editing
```

Routes:
- `GET /v1/swaps/quote?inputMint=...&outputMint=...&amount=...&slippageBps=50` is public and returns `{inAmount,outAmount,otherAmountThreshold,priceImpactPct,slippageBps,feeBps,router}`. Amounts are base-unit decimal strings; `priceImpactPct` is percentage points, not a decimal fraction.
- `POST /v1/swaps` requires Privy auth and a primary linked Solana wallet, with body `{inputMint,outputMint,amount,slippageBps?}`. Returns 201 `{requestId,transaction,expiresAt,...quoteFields}`. Expiry is Unix milliseconds, capped at 30 seconds and the sponsor's blockhash lifetime. The review dialog uses this build response, not an earlier preview; a new build requires a new signature.
- `POST /v1/swaps/{requestId}/submit` requires auth, body `{signedTransaction}`. Returns `{status:"confirmed"|"failed"|"submitted",signature?,inputAmountResult?,outputAmountResult?,code?,error?}`. Co-signed bytes go only to Jupiter, never the client or storage. A request is claimed atomically before co-signing; retries cannot sign or execute it again. Unknown execution outcomes stay `submitted`; reconciliation is indexing work, not an automatic resubmission.
- `GET /v1/swaps/{requestId}` requires auth and returns 404 unless owned by the caller. Response `{requestId,status,signature?,inAmount?,outAmount?,error?}`; status is `issued|submitted|confirmed|failed|expired`. `expired` is derived for unsubmitted issued swaps. Amounts are execution results when available, otherwise the original input and quoted output, not proof of a fill.
- `GET /v1/swaps?limit=25&cursor=...` requires auth and lists only the caller's swaps, including expired issued records, without requiring a linked wallet or enabled trading. Returns `{items,nextCursor}`; items contain the status response fields plus `inputMint`, `outputMint`, and `createdAt` (UTC ISO 8601). Amounts have the same execution-or-quote semantics as status. Newest first by creation time at millisecond precision, then request ID descending for stable ties. Limit defaults to 25, maximum 100. Like the feed, cursors are opaque base64url JSON: pass `nextCursor` unchanged; `null` means no further page. Malformed cursors/limits return 400. This supplies the terminal's My Swaps placeholder; frontend consumption is a separate change.

Build/submit return `503 trading_disabled` until a concrete enabled FeeSponsor is wired. Sponsor policy rejections return `422 sponsor_rejected`; order safety checks return `422 swap_rejected` with `details.reason`. The shared v0.1 mint list lives in `src/services/sponsor/swap-mints.ts`. Sponsor registration/co-signing owns the remaining policy checks (simulation, $5 minimums, rent/account limits, sponsored transaction/spend/failure quotas); no enabled fallback exists without them.

Jupiter V2 returns no single `payer` field: validate `rentFeePayer`, `prioritizationFeePayer` when present, and `signatureFeePayer` against our payer. JupiterZ may use a market maker for signatures (never the taker); the sponsor validates actual account roles. Current docs expose `priceImpact` in percentage points; legacy `priceImpactPct` is a decimal ratio and is multiplied by 100. Jupiter `Success` means landed, not merely submitted.

The `swaps` table is the source of truth for issued swaps and raw execution outcomes, with a unique signature. Existing `trades`/PnL rows are populated by indexing work; the swap API does not invent USD prices or token metadata.

The demo frontend may still show fixture estimates; live submission remains disabled until the concrete sponsor passes the security-policy checks.

## Market data

Live is the default; `MARKET_DATA_PROVIDER=mock` keeps offline/demo feeds.
Caches deduplicate in-flight requests; failures/timeouts return 502, not fixtures.

```mermaid
sequenceDiagram
  participant C as Client
  participant A as API / live provider
  participant K as In-memory cache
  participant J as Jupiter
  participant B as Birdeye
  C->>A: GET /v1/tokens/{mint} or /trending
  alt Detail mint not allowlisted
    A-->>C: 404
  else Allowlisted detail or curated trending
    A->>K: Read token snapshot (5s TTL)
    alt Cache miss
      K->>J: Tokens V2 search (15s cache, batches <=100)
      J-->>K: Metadata + 24h stats
      K->>J: Price V3 (batches <=50)
      J-->>K: USD prices
    end
    K-->>A: Mapped tokens
    A-->>C: Token or volume-ranked trending list (limit)
  end
  C->>A: GET /v1/tokens/{mint}/candles or /trades
  Note over A,K: Resolve token first via the same allowlist/cache path; unknown = 404
  alt BIRDEYE_API_KEY unset
    A-->>C: 503 service_unavailable
  else Key configured
    A->>K: Read candles (30s) or trades (5s)
    alt Cache miss
      K->>B: OHLCV V3 or token swap txs (Solana, API key)
      B-->>K: Candles with USD volume or swap legs
    end
    K-->>A: Oldest-first candles / newest-first trades
    A-->>C: Mapped DTOs
  end
```

### Price WebSocket ticks

Payload: `{mint,priceUsd,marketCapUsd,time}`; time is Unix seconds.

```mermaid
flowchart TD
  T[5s tick in live mode] --> R{Previous tick running?}
  R -- Yes --> S[Skip tick]
  R -- No --> H[Read active WsHub topics]
  H --> F[Keep token:&lt;mint&gt;:price topics<br/>with subscribers and allowlisted mints]
  F --> N{Any eligible topics?}
  N -- No --> S
  N -- Yes --> G[Concurrent getToken calls<br/>shared snapshot cache and in-flight dedupe]
  G --> K{5s token snapshot cached?}
  K -- Yes --> P
  K -- No --> J[Batched Jupiter Price V3<br/>refresh Tokens V2 only after 15s]
  J -- Success --> P[Recheck topic still subscribed]
  J -- Failure --> S
  P --> U[Publish price tick to subscribed topics only]
```

The shared provider batches the allowlist, not one request per subscriber.
Mock mode emits synthetic price ticks on its mock-feed timer only.

### Trade WebSocket topics (mock only)

```mermaid
sequenceDiagram
  participant W as Web
  participant H as WS hub
  participant F as Feed (mock only)
  W->>H: connect /ws
  W->>H: {"op":"subscribe","topic":"token:<mint>:trades"}
  F->>H: trade
  H-->>W: {"topic":"token:<mint>:trades","data":{...}}
  W->>W: Prepend to query cache, update last candle
  Note over W,H: On drop: exponential backoff (max 30s), resubscribe, refetch REST snapshot
```

Topics: `token:<mint>:trades`, `token:<mint>:price`, `leaderboard:global`; per-user alert topics are reserved. The status strip shows Live / Connecting / Reconnecting and the age of the last message; the chart never fills gaps with invented candles.

## Follow and following feed

```mermaid
sequenceDiagram
  participant W as Web
  participant A as API
  participant U as UserService
  participant R as FollowRepository
  participant S as SocialProvider (demo)
  W->>A: PUT /v1/follows/{wallet} (Bearer token)
  A->>A: Verify token and validate Solana address
  A->>U: ensureUser(auth)
  U-->>A: viewer with owned wallets
  alt Target is an owned wallet
    A-->>W: 400
  else Other wallet (registered or not)
    A->>R: follow(viewer.id, wallet), on conflict do nothing
    A-->>W: 204
  end
  W->>A: GET /v1/feed?scope=following&limit=25 (Bearer token)
  A->>U: ensureUser(verified auth)
  A->>R: listWallets(viewer.id)
  R-->>A: wallets (possibly empty)
  A->>S: feed(wallets, decoded cursor, limit)
  S-->>A: newest items + opaque nextCursor
  A-->>W: 200 items + nextCursor (null at end)
  W->>A: DELETE /v1/follows/{wallet} (Bearer token)
  A->>R: unfollow(viewer.id, wallet)
  A-->>W: 204 (even when absent)
```

Global feed is public and is the default scope; following scope without a bearer token returns 401. Optional authentication on feed and leaderboard means no header is anonymous, but a present invalid header returns 401. Invalid cursors, limits, scopes and wallet addresses return 400. Following nobody returns an empty page. Feed content remains demo data, independent of indexed leaderboard rankings. Trades include side/amountUsd, theses include body, and both use the comment position enum and Unix-second timestamps. Authenticated leaderboard entries include `isFollowing` for both indexed and demo rankings; anonymous entries omit it.

## PnL

```mermaid
flowchart TD
  T[Parsed trade: amount a, USD proceeds or spend u] --> SIDE{Side}
  SIDE -- Buy --> BUY[qty += a; cost += u]
  SIDE -- Sell --> SELL[s = min a, qty]
  SELL --> BASIS[basis = cost * s / qty; zero if qty is zero]
  BASIS --> REAL[realized = u * s / a - basis]
  REAL --> REMAIN[cost -= basis; qty -= s; accumulate realized]
  BUY --> VAL[Open value = qty * current price]
  REMAIN --> VAL
  VAL --> UNREAL[Unrealized = value - cost]
  UNREAL --> RANK[Window PnL = window realized + all open unrealized]
  RANK --> METRICS[Volume = window quote USD sum; trades = window count]
  METRICS --> PCT[PnL percent = PnL / window buy volume * 100]
  PCT --> WIN[Win rate = profitable sells / sells * 100]
  WIN --> ELIG{At least one trade in window?}
  ELIG -- Yes --> REDIS[Rank by PnL in Redis; publish WS invalidation]
  ELIG -- No --> REMOVE[Remove from window]
```

Zero denominators produce zero. Native SOL network fees are added back before
classification, not subtracted again from realized PnL. SOL-quoted USD values use
current SOL pricing; historical prices remain a TODO. Unknown current token prices
or zero prices use average cost (zero unrealized). Transfers are not indexed.
Tokens acquired before indexing or delivered out of order have unknown (zero) basis;
sells without indexed holdings record zero realized PnL. Transactions are not reordered.
Stablecoin quote legs take priority over SOL; dust below 0.000000001 units is ignored.

### Portfolio reads and daily snapshots

```mermaid
sequenceDiagram
  participant C as Authenticated client
  participant A as PortfolioService
  participant D as PostgreSQL
  participant M as MarketDataProvider
  participant S as Solana JSON-RPC
  C->>A: GET /v1/me/portfolio
  A->>D: ensureUser; positions + linked wallets
  A->>M: Current held-token prices
  A->>S: getTokenAccountsByOwner (USDC + USDT, jsonParsed); getBalance (native SOL)
  A-->>C: equity = USDC + USDT + SOL * current price + open value
  C->>A: GET /v1/me/portfolio/history?range=7d|30d|all
  A->>D: Daily snapshots ascending within range
  A-->>C: UTC midnight points + final live equity point
  C->>A: GET /v1/me/trades?limit=25&cursor=opaque
  A->>D: Keyset by executedAt DESC, id DESC
  A-->>C: UserTrade entries + nextCursor or null
  Note over A,D: Daily worker includes cash-only linked wallets and upserts (userId, UTC day)
```

Closed positions contribute accumulated realized PnL but are not listed. Buys
return `realizedPnlUsd: null` in `UserTrade`. Malformed cursors return 400; missing
auth returns 401. RPC failures log and omit only the failed wallet/asset, retaining
successful balances. `usdcBalance` is USDC only. Missing/zero SOL prices value
native SOL cash at zero. Range start is UTC midnight
7/30 days before today (inclusive), or all stored days. No synthetic history is added.
