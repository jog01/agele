# Decisions (ADRs)

Short records; each says what we chose, why, and what would change it.

1. **Bun + TypeScript for API, WS and jobs; no Rust in v0.1.** Workload is I/O-bound (providers, DB, fan-out). Revisit Rust for a custom indexer or if WS fan-out exceeds a single Bun process.
2. **Two plain packages (`api/`, `web/`), no workspace tooling.** Matches the "normal package manager, not a monorepo" ask. The contract between them is `api/openapi.json`, regenerated with `bun run openapi` (api) and `bun run api:types` (web).
3. **Hono + zod-openapi.** One schema per route gives validation, types and docs. Error envelope `{ error: { code, message } }`.
4. **Drizzle + Postgres, SQL migrations committed.** Typed queries, readable migrations, no runtime codegen.
5. **Providers behind interfaces, chosen in `container.ts`.** Market data, social, swaps and fee sponsorship are interfaces with mock implementations, so the UI is usable without keys and onchain/security owners can land real ones independently.
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
