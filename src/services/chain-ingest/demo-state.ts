import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { chainTokens, chainTrades } from "../../models/chain";
import { type DemoTokenLabel, DemoTokenLabels, demoMetadataUri, demoTokenImage } from "./demo-metadata";

export const DEMO_ACTIVE_MARKETS = 48;

type DemoTrade = Pick<
  typeof chainTrades.$inferSelect,
  "trader" | "side" | "venue" | "solAmountLamports" | "tokenAmountRaw"
>;

export type DemoState = {
  labels: DemoTokenLabel[];
  markets: { mint: string; pool: string; migrated: boolean; trades: DemoTrade[] }[];
  tip: { time: number; nextTransactionIndex: number };
};

export function readDemoState(db: Db): Promise<DemoState | null> {
  return db.transaction(
    async (tx) => {
      const markets = await tx
        .select({
          mint: chainTokens.mint,
          pool: chainTokens.pool,
          launchedAt: chainTokens.launchedAt,
          migratedAt: chainTokens.migratedAt,
        })
        .from(chainTokens)
        .where(eq(chainTokens.source, "demo"))
        .orderBy(desc(chainTokens.launchedAt), chainTokens.mint)
        .limit(DEMO_ACTIVE_MARKETS);
      if (!markets.length) return null;

      const tokens = await tx
        .select({
          mint: chainTokens.mint,
          name: chainTokens.name,
          symbol: chainTokens.symbol,
          imageUrl: chainTokens.imageUrl,
        })
        .from(chainTokens)
        .where(eq(chainTokens.source, "demo"))
        .orderBy(chainTokens.launchedAt, chainTokens.mint);
      const generated = tokens.filter(({ mint, imageUrl }) => imageUrl === demoTokenImage(mint));
      const other = tokens.filter(({ mint, imageUrl }) => imageUrl !== demoTokenImage(mint));
      const names = new Set(other.map(({ name }) => name.toLowerCase()));
      const symbols = new Set(other.map(({ symbol }) => symbol.toLowerCase()));
      const allocator = new DemoTokenLabels(tokens);
      const labels = other.map(({ name, symbol }) => ({ name, symbol }));
      for (const { mint, name, symbol } of generated) {
        const nameKey = name.toLowerCase();
        const symbolKey = symbol.toLowerCase();
        const renameName = names.has(nameKey);
        const renameSymbol = symbols.has(symbolKey);
        names.add(nameKey);
        symbols.add(symbolKey);
        const label = allocator.claim(mint, { name, symbol }, renameName, renameSymbol);
        labels.push(label);
        if (renameName || renameSymbol) {
          await tx
            .update(chainTokens)
            .set({ ...label, metadataUri: demoMetadataUri(label, demoTokenImage(mint)) })
            .where(and(eq(chainTokens.source, "demo"), eq(chainTokens.mint, mint)));
        }
      }

      const [trades, [lastTrade]] = await Promise.all([
        tx
          .select({
            mint: chainTrades.mint,
            trader: chainTrades.trader,
            side: chainTrades.side,
            venue: chainTrades.venue,
            solAmountLamports: chainTrades.solAmountLamports,
            tokenAmountRaw: chainTrades.tokenAmountRaw,
          })
          .from(chainTrades)
          .where(
            and(
              eq(chainTrades.source, "demo"),
              inArray(
                chainTrades.mint,
                markets.map(({ mint }) => mint),
              ),
            ),
          )
          .orderBy(chainTrades.time, chainTrades.orderKey),
        tx
          .select({ time: chainTrades.time, orderKey: chainTrades.orderKey })
          .from(chainTrades)
          .where(eq(chainTrades.source, "demo"))
          .orderBy(desc(chainTrades.time), desc(chainTrades.orderKey))
          .limit(1),
      ]);
      const byMint = new Map<string, DemoTrade[]>();
      for (const { mint, ...trade } of trades) {
        const fills = byMint.get(mint);
        if (fills) fills.push(trade);
        else byMint.set(mint, [trade]);
      }
      const launchTime = markets[0]!.launchedAt;
      const time = Math.max(launchTime, lastTrade?.time ?? 0);
      const nextTransactionIndex =
        lastTrade?.time === time
          ? Number(lastTrade.orderKey.split(":")[1]) + (launchTime === time ? 2 : 1)
          : 1;
      return {
        labels,
        markets: markets.reverse().map(({ mint, pool, migratedAt }) => ({
          mint,
          pool,
          migrated: migratedAt !== null,
          trades: byMint.get(mint) ?? [],
        })),
        tip: { time, nextTransactionIndex },
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
