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

Without provider keys the API serves labelled demo fixtures. Set `PRIVY_APP_ID` / `PRIVY_VERIFICATION_KEY` to enable authenticated routes.

### Swap environment

- `JUPITER_BASE_URL`: defaults to `https://api.jup.ag`; `JUPITER_API_KEY` sets the `x-api-key` header when configured. Swap previews use live Jupiter, not demo quotes.
- `SPONSOR_ENABLED`: boolish (`true`/`false`/`1`/`0`), default `false`. Trading also requires a concrete `FeeSponsor` in the container; until that implementation is wired, build/submit return `503 trading_disabled`. Public quotes still work.
- `FEE_PAYER_PUBKEY`: sponsor wallet address. `FEE_PAYER_SECRET`: development-only signer material; rejected outside `NODE_ENV=development`. Neither is used by the disabled sponsor.
- `MAX_SLIPPAGE_BPS`: default `300`, client default `50`. `MAX_PRICE_IMPACT_PCT`: default `3` percentage points.
- Postgres persists issued swaps and execution outcomes; Redis enforces quote/issue limits (30/min per IP and authenticated issuing user). Further sponsorship economics, simulation and quotas belong to `FeeSponsor` under the security policy.

Swap routes: public `GET /v1/swaps/quote`, authenticated `POST /v1/swaps`, `POST /v1/swaps/{requestId}/submit`, and `GET /v1/swaps/{requestId}`. See [Trade](docs/flows.md#trade-quote-review-sign-receipt) and `/docs` for contracts.

## Checks

```bash
bun run check   # biome, tsc, bun test
```

## API contract

`openapi.json` is generated from the routes and committed. After changing a route, run `bun run openapi` and commit the result; agele-web regenerates its types from it with `bun run api:types`.
