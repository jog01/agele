# Agele

Social trading terminal for Solana spot markets. The product name is set in one place, `web/src/lib/config.ts` (`PRODUCT_NAME`); the repo is still named `fomo` until it is renamed.

- `api/`: Bun + Hono REST/WebSocket API, Drizzle/Postgres, BullMQ worker
- `web/`: Next.js 16 + shadcn/ui terminal
- `docs/`: [architecture](docs/architecture.md), [flows](docs/flows.md), [decisions](docs/decisions.md)

## Run locally

Requires Bun 1.4+ and Docker.

```bash
docker compose up -d                 # Postgres + Redis (add --profile observability for Jaeger)
cd api && bun install && cp .env.example .env && bun run db:migrate && bun run dev   # :4000, docs at /docs
cd web && bun install && cp .env.example .env.local && bun run dev                  # :3000
```

Open http://localhost:3000/trade. Without provider keys everything runs on labelled demo data and trading is disabled. Set `NEXT_PUBLIC_PRIVY_APP_ID` (web) and `PRIVY_APP_ID` / `PRIVY_VERIFICATION_KEY` (api) to enable sign-in.

## Checks

```bash
cd api && bun run check   # biome, tsc, bun test
cd web && bun run check   # biome, tsc, vitest
```

After changing API routes: `cd api && bun run openapi && cd ../web && bun run api:types`.
