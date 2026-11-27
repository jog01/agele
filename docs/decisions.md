# Decisions (ADRs)

Short records; each says what we chose, why, and what would change it.

1. **Bun + TypeScript for API, WS and jobs; no Rust in v0.1.** Workload is I/O-bound (providers, DB, fan-out). Revisit Rust for a custom indexer or if WS fan-out exceeds a single Bun process.
2. **Two repos, each a plain single package: jog01/agele (backend) and jog01/agele-web (frontend).** Matches the "normal package manager, not a monorepo" ask and lets each deploy on its own. The contract is `openapi.json`, committed here and regenerated with `bun run openapi`; agele-web commits the generated `src/lib/api/schema.d.ts` and refreshes it with `bun run api:types` (reads `OPENAPI_URL`, default the local API).
3. **Hono + zod-openapi.** One schema per route gives validation, types and docs. Error envelope `{ error: { code, message } }`.
4. **Drizzle + Postgres, SQL migrations committed.** Typed queries, readable migrations, no runtime codegen.
5. **Providers behind interfaces, chosen in `container.ts`.** Market data, swaps and fee sponsorship use provider boundaries. The social API uses PostgreSQL in all environments; demo mode seeds the same store.
6. **Privy embedded wallets; non-custodial.** The server never holds user keys. Access tokens verified with `@privy-io/node` `verifyAccessToken`.
7. **Sponsored network fees via our own fee payer with Jupiter Swap V2.** Users need only USDC. The fee payer is isolated in `FeeSponsor` with strict validation before co-signing.
8. **Solana spot, USDC quote, curated allowlist for v0.1.** Perps, multi-chain, copy trading, limit/TP/SL, sniping, fiat on-ramp are deferred and are not shown as inert controls.
9. **Explicit review before every signature.** No one-click or silent signing; review shows receive, min receive, slippage, impact, fees, destination mint and expiry.
10. **Honest demo mode.** Fixture data is labelled "Demo data · trading disabled" everywhere; no fake balances, fills or PnL for the user.
11. **REST snapshot + WS deltas.** WS frames merge into the TanStack Query cache; reconnect triggers a REST refetch so the client never drifts.
12. **Next.js 16 with Cache Components.** Static shells prerender; anything that reads time or URL params sits in client components or under `<Suspense>`.
13. **Graphite/Ice dark theme only for v0.1,** Geist / Geist Mono, data text at least 12px, colour never the only signal (icons/labels on changes and sides).
14. **Merging:** squash by default, rebase when separate commits matter, never merge commits.

## Open questions

- Final product name and domain.
- Fee model: platform fee bps on swaps, and a cap on sponsored network fees per user per day.
- Token allowlist policy beyond the initial set (manual curation vs. liquidity/volume thresholds).
- Public profiles: are all trades public by default, or opt-in?
- Hosting (Vercel for web; Fly/Railway/AWS for API, Postgres, Redis).

## 2026-11-18 — Four process entrypoints, one application

Split REST API, WebSocket gateway, BullMQ worker and market-data feed. Their
lifecycles differ: requests should not wait on indexing, websocket connections
need independent replication, scheduled/retried work belongs in BullMQ, and
upstream market polling should have one elected owner. A Redis pub/sub bus fans
events to every gateway; active-topic heartbeats avoid polling unused markets.

This is not microservices: services, repositories, types, release artifact and
PostgreSQL schema remain shared. No internal HTTP/RPC layer or separate service
databases are introduced. BullMQ schedulers deduplicate schedule registration
across worker replicas; a Redis token lease protects feed ownership.

Run migrations as a one-off `bun run db:migrate` job before deploy, not a fifth
process. Only existing rebuild/snapshot logic is scheduled. Reconciliation,
historical backfills and alerts need explicit correctness contracts before they
can become scheduled jobs.

## 2026-11-27 — SOL quote, USD accounting and separate fee paths

For v0.2, quote SOL pairs in SOL and keep PnL and rankings in USD. Prefer user-paid
fees when the wallet can afford them; only that path may tip Jito. Keep gasless
landing on Jupiter under the existing sponsor policy. Sponsored native SOL
settlement and the wallet-value eligibility rule require policy amendments.
See the [design and rollout](sol-quote-and-fees.md).
