# Agele API

Backend for Agele, a social trading terminal for Solana spot markets: Bun + Hono REST/WebSocket API, Drizzle/Postgres, Redis, BullMQ worker. The Next.js frontend lives in [jog01/agele-web](https://github.com/jog01/agele-web).

- `docs/`: [architecture](docs/architecture.md), [flows](docs/flows.md), [decisions](docs/decisions.md), [data model](docs/data-model.md), [fee-payer security policy](docs/fee-payer-security-policy.md)

## Run locally

Requires Bun 1.4+ and Docker.

```bash
docker compose up -d          # Postgres + Redis (add --profile observability for Jaeger)
bun install
cp .env.example .env
bun run db:migrate
bun run dev                   # :4000, API docs at /docs, WebSocket at /ws
```

Keyless Jupiter market data works by default; candles/trades need a Birdeye key.
Set `MARKET_DATA_PROVIDER=mock` for demo market fixtures. Leaderboard responses
label fixture rankings with `X-Data-Source: demo` (indexed rankings: `indexed`). Set `PRIVY_APP_ID` /
`PRIVY_VERIFICATION_KEY` to enable authenticated routes.

## Trade indexing and portfolios

| Environment variable | Purpose |
| --- | --- |
| `HELIUS_API_KEY` | Helius management API key for `bun run helius:sync` |
| `HELIUS_WEBHOOK_SECRET` | Exact Authorization header expected on webhook delivery; enables indexed Redis rankings when set |
| `HELIUS_WEBHOOK_URL` | Public HTTPS callback, including `/v1/webhooks/helius`, used by sync |
| `SOLANA_RPC_URL` | JSON-RPC endpoint for linked-wallet USDC balances |
| `DATABASE_URL` / `REDIS_URL` | PostgreSQL source of truth / rebuildable rankings and BullMQ |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Auth verification / linked Solana wallet discovery |

To go live: migrate Postgres, run Redis, configure Privy and live market data,
set the Helius API key, strong webhook secret and public HTTPS callback URL,
then run `bun run helius:sync` after wallets are linked. **Rerun sync whenever
linked wallets change**; it is deliberately not called in the sign-in request
path (external management calls cost credits and can fail). Sync matches the
callback URL, creates or updates an enhanced `ANY` webhook, and refuses empty
wallet lists. No historical trades are backfilled. Never log management responses:
they may contain the webhook secret.

The [current Helius reference](https://www.helius.dev/docs/api-reference/webhooks/llms.txt)
documents `https://mainnet.helius-rpc.com/v0/webhooks` (rather than the older
`api-mainnet` hostname), with GET/POST and PUT `/{webhookID}`. The sync script
uses that base. [Request fields](https://www.helius.dev/docs/api-reference/webhooks/create-webhook)
include `webhookURL`, `accountAddresses`, `transactionTypes`, `webhookType`, `authHeader`.

Authenticated endpoints: `GET /v1/me/portfolio`, `GET /v1/me/portfolio/history?range=7d|30d|all`,
and `GET /v1/me/trades?limit=25&cursor=...`. Run `bun run dev:worker` for daily
UTC equity snapshots. The API rebuilds rankings at startup and every 60 seconds,
and refreshes a user's rankings after each indexed trade. WS `leaderboard:global`
sends `{window,updatedAt}` invalidations; refetch `GET /v1/leaderboard`.

Limitations: only one non-quote token against USDC/USDT/SOL is indexed; transfers
and failed transactions are skipped. Native SOL fees are added back, wSOL is
merged with SOL, and SOL legs use **current**, not historical, USD pricing.
Unknown market prices fall back to average cost (zero unrealized PnL); configure
the market allowlist for held tokens. RPC balance errors log and return zero.
Comments remain mock. Mock leaderboard responses stay explicitly demo-labelled;
indexed rankings never fall back to synthetic entries on Redis failure.

## Checks

```bash
bun run check   # biome, tsc, bun test
```

## API contract

`openapi.json` is generated from the routes and committed. After changing a route, run `bun run openapi` and commit the result; agele-web regenerates its types from it with `bun run api:types`.

## Market data

Market data defaults to `MARKET_DATA_PROVIDER=live`: Jupiter Tokens V2 metadata
and Price V3 prices. Without `JUPITER_API_KEY`, requests use lite-api.jup.ag;
a key selects api.jup.ag. Metadata caches for 15 seconds, prices for 5 seconds,
with shared in-flight requests, metadata batches of 100 and price batches of 50.
Missing numeric metrics default to zero. See [market-data flows](docs/flows.md#market-data).

v0.1 uses `MARKET_TOKEN_ALLOWLIST` (comma-separated mints), defaulting to the eight
mock seed tokens. Unknown mints return 404; trending sorts these tokens by 24h
volume. Candles (30s cache) and swap trades (5s cache) require `BIRDEYE_API_KEY`;
without it they return 503, never synthetic data. Upstream errors/timeouts return
502. Set `MARKET_DATA_PROVIDER=mock` for offline fixtures and synthetic WS feeds
(`ENABLE_MOCK_FEED=true`).

`GET /health` reports the active `marketData` provider. WS `token:<mint>:price`
events contain `{mint,priceUsd,marketCapUsd,time}` (Unix seconds), polled every
5 seconds for subscribed allowlisted tokens only. Live trade data uses REST;
the `token:<mint>:trades` WS feed remains mock-only.
