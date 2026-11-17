# Agele API

Backend for Agele, a social trading terminal for Solana spot markets: Bun + Hono REST/WebSocket API, Drizzle/Postgres, Redis, BullMQ worker. The Next.js frontend lives in [jog01/agele-web](https://github.com/jog01/agele-web).

- `docs/`: [architecture](docs/architecture.md), [flows](docs/flows.md), [decisions](docs/decisions.md), [fee-payer security policy](docs/fee-payer-security-policy.md)

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

## Checks

```bash
bun run check   # biome, tsc, bun test
```

## API contract

`openapi.json` is generated from the routes and committed. After changing a route, run `bun run openapi` and commit the result; agele-web regenerates its types from it with `bun run api:types`.
