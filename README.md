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
Set `MARKET_DATA_PROVIDER=mock` for labelled demo fixtures. Set `PRIVY_APP_ID` /
`PRIVY_VERIFICATION_KEY` to enable authenticated routes.

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
