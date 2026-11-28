import { createHash } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { decimal, divide, formatDecimal } from "../lib/decimal";
import {
  comments,
  follows,
  portfolioSnapshots,
  positions,
  publicPortfolioHourly,
  reactions,
  theses,
  tokens,
  trades,
  users,
} from "../models";
import { insertNotifications } from "../repositories/notification.repository";
import { PgTradeRepository } from "../repositories/trade.repository";
import { USDC_MINT } from "../services/helius-parser";
import { MockMarketDataProvider } from "../services/market-data/mock.provider";
import { positionEpisodes } from "../services/position-episodes";
import type { Db } from "./client";

const traders = [
  [
    "northstar",
    "Nora",
    "I trade the open and leave the afternoon alone.",
    "Watching the first SOL pullback after the open. If the bid holds, I'll keep a runner.",
  ],
  [
    "basispoints",
    "Marin",
    "Small size, swing timeframes, lots of notes.",
    "JUP is back at last week's range low. Starter size until it takes the midpoint.",
  ],
  [
    "bonkledger",
    "Teo",
    "Tracking meme liquidity, not follower counts.",
    "BONK volume improved without much price extension. I like that better than chasing the first candle.",
  ],
  [
    "tapereader",
    "Amelia",
    "Mostly flat; I wait for an obvious invalidation.",
    "WIF held its prior breakout on a quiet retest. I'll cut it if we lose that level on volume.",
  ],
  [
    "fadesonly",
    "Suki",
    "A countertrend trader who still uses stops.",
    "Letting TRUMP settle after the spike. My entry is small enough to wait out the first retrace.",
  ],
  [
    "onchainlee",
    "Lee",
    "Watching liquid names and writing down every exit.",
    "Liquidity recovered faster than price today. Took a little exposure, with a hard stop below the range.",
  ],
  [
    "solails",
    "Dani",
    "Swing trades around a core SOL position.",
    "Keeping the slower position and scaling out of the short-term trade into this offer.",
  ],
  [
    "routefinder",
    "Priya",
    "Execution nerd. Logs slippage on every trade.",
    "The fill was cleaner than expected, but I'm not adding unless the spread stays narrow.",
  ],
  [
    "smallsize",
    "Ben",
    "My default position is smaller than my conviction.",
    "Took off a quarter into resistance. I'd rather reload lower than give back the whole move.",
  ],
  [
    "wickwatch",
    "Iris",
    "Reclaims and failed breakdowns on the hourly.",
    "The sell sweep got absorbed. I'm long the reclaim, not the breakout.",
  ],
  [
    "closingbell",
    "Rafi",
    "Watching closes, ignoring most five-minute bars.",
    "This is still inside the daily range. Happy with the starter but won't average down today.",
  ],
  [
    "candlejournal",
    "June",
    "Trade journal first, takes second.",
    "Trimmed on the bounce; that leaves enough size to test my read without chasing the next leg.",
  ],
] as const;

const followGraph = [
  [1, 6, 9],
  [0, 7, 10],
  [3, 4, 9],
  [0, 2, 11],
  [2, 3],
  [0, 7, 8],
  [0, 5, 7],
  [1, 5, 6],
  [1, 7, 11],
  [2, 3, 10],
  [0, 1, 9],
  [3, 8, 10],
];
const replies = [
  "Watching that level too. I'd like to see it hold on a second test.",
  "My fill was a little wider there. Keeping the rest of my orders smaller.",
  "Same read on liquidity. I'm waiting for the close before adding.",
];
const day = 86_400;
const seedId = (group: number, index: number) =>
  `ade10000-0000-4000-800${group}-${index.toString(16).padStart(12, "0")}`;
const demoWallet = (handle: string) =>
  getBase58Decoder().decode(createHash("sha256").update(`agele demo wallet:${handle}`).digest());

async function upgradeDemoFill(
  db: Db,
  fill: { userId: string; signature: string; mint: string; timestamp: number },
  legacyTimestamp: number,
  milestoneProceeds?: bigint,
) {
  await db.transaction(async (tx) => {
    const [profile] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, fill.userId), eq(users.demo, true)))
      .for("update");
    if (!profile) return;
    const [legacy] = await tx
      .select()
      .from(trades)
      .where(
        and(
          eq(trades.userId, fill.userId),
          eq(trades.signature, fill.signature),
          eq(trades.mint, fill.mint),
          eq(trades.executedAt, new Date(legacyTimestamp * 1000)),
        ),
      );
    if (!legacy) return;
    const executedAt = new Date(fill.timestamp * 1000);
    if (milestoneProceeds === undefined || legacy.realizedPnlUsd === null) {
      await tx.update(trades).set({ executedAt }).where(eq(trades.id, legacy.id));
      return;
    }
    const delta = milestoneProceeds - decimal(legacy.quoteAmountUsd);
    await tx
      .update(trades)
      .set({
        executedAt,
        quoteAmountUsd: formatDecimal(milestoneProceeds),
        priceUsd: formatDecimal(divide(milestoneProceeds, decimal(legacy.tokenAmount))),
        realizedPnlUsd: formatDecimal(decimal(legacy.realizedPnlUsd) + delta),
      })
      .where(eq(trades.id, legacy.id));
    await tx
      .update(positions)
      .set({ realizedPnlUsd: sql`${positions.realizedPnlUsd} + ${formatDecimal(delta)}::numeric` })
      .where(and(eq(positions.userId, fill.userId), eq(positions.mint, fill.mint)));
  });
}

export async function seedSocialDemo(db: Db, now = Date.now()) {
  const profiles = traders.map(([handle, displayName, bio], index) => ({
    id: seedId(0, index),
    privyDid: `demo:agele:${handle}`,
    walletAddress: demoWallet(handle),
    handle,
    displayName,
    bio,
    avatarUrl: `https://api.dicebear.com/9.x/notionists/png?seed=${handle}`,
    demo: true,
    createdAt: new Date((Math.floor(now / 1000) - 35 * day) * 1000),
  }));
  await db.insert(users).values(profiles).onConflictDoNothing({ target: users.id });
  const [first] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, profiles[0]!.id));
  const [baseline] = await db
    .select({ executedAt: trades.executedAt })
    .from(trades)
    .where(and(eq(trades.userId, profiles[0]!.id), eq(trades.signature, "demo:northstar:0")));
  const anchor = baseline
    ? baseline.executedAt.getTime() / 1000 + 21 * day
    : first!.createdAt.getTime() / 1000 + 35 * day;
  const market = new MockMarketDataProvider(() => anchor * 1000);
  const mints = MockMarketDataProvider.mints;
  const metadata = await Promise.all(mints.map((mint) => market.getToken(mint)));
  const repository = new PgTradeRepository(db);
  for (const [index, profile] of profiles.entries()) {
    const { mint, symbol, name, imageUrl, decimals, priceUsd, marketCapUsd } =
      metadata[index % mints.length]!;
    const quantity = 2 * Math.max(2, Math.round((500 + index * 145) / priceUsd));
    const legs = [
      [21 * day, "buy", quantity, 86],
      [16 * day, "sell", quantity, index === 11 ? 155 : 93 + (index % 5)],
      [4 * day, "buy", quantity, 95 + index],
      [2 * day, "sell", quantity / 2, 96 + (index % 5)],
      [3600, "buy", quantity, 91 + index],
      [600, "sell", quantity / 2, 103 - index],
    ] as const;
    for (const [leg, [age, side, amount, percent]] of legs.entries()) {
      const usd = decimal(((priceUsd * amount * percent) / 100).toFixed(2));
      const fill = {
        userId: profile.id,
        wallet: profile.walletAddress,
        mint,
        symbol,
        name,
        imageUrl,
        decimals,
        amount: decimal(String(amount)),
        usd,
        marketCapUsd: (marketCapUsd * Number(formatDecimal(usd))) / (priceUsd * amount),
        quoteAmount: usd,
        quoteMint: USDC_MINT,
        side,
        signature: `demo:${profile.handle}:${leg}`,
        timestamp: anchor - age - (index % mints.length) * 60,
      };
      const stored = await repository.record(fill);
      const legacyTimestamp = anchor - age - index * 60;
      if (!stored && legacyTimestamp !== fill.timestamp) {
        await upgradeDemoFill(db, fill, legacyTimestamp, index === 11 && leg === 1 ? usd : undefined);
      }
      if (!stored) {
        await db
          .update(trades)
          .set({ marketCapUsd: sql`${trades.priceUsd} * ${marketCapUsd / priceUsd}::numeric` })
          .where(
            and(
              eq(trades.userId, profile.id),
              eq(trades.signature, fill.signature),
              isNull(trades.marketCapUsd),
            ),
          );
      }
    }
    const joinedAt = new Date((anchor - 35 * day) * 1000);
    if (first!.createdAt > joinedAt)
      await db.update(users).set({ createdAt: joinedAt }).where(eq(users.id, profile.id));
    const fills = await db
      .select()
      .from(trades)
      .where(eq(trades.userId, profile.id))
      .orderBy(asc(trades.executedAt));
    const valueAt = async (time: number) => {
      let held = 0;
      for (const fill of fills) {
        if (fill.executedAt.getTime() > time * 1000) break;
        held += Number(fill.tokenAmount) * (fill.side === "buy" ? 1 : -1);
      }
      const historical = new MockMarketDataProvider(() => time * 1000);
      return (Math.max(0, held) * (await historical.getToken(mint))!.priceUsd).toFixed(2);
    };
    const nowSeconds = Math.floor(now / 1000);
    const midnight = Math.floor(nowSeconds / day) * day;
    const snapshots = [];
    for (let i = 30; i >= 0; i--) {
      const time = midnight - i * day;
      const valueUsd = await valueAt(time);
      snapshots.push({
        userId: profile.id,
        day: new Date(time * 1000).toISOString().slice(0, 10),
        valueUsd,
        positionsValueUsd: valueUsd,
      });
    }
    const hour = Math.floor(nowSeconds / 3600) * 3600;
    await db
      .insert(publicPortfolioHourly)
      .values(
        await Promise.all(
          Array.from({ length: 25 }, async (_, index) => {
            const time = hour - index * 3600;
            return { userId: profile.id, hour: new Date(time * 1000), valueUsd: await valueAt(time) };
          }),
        ),
      )
      .onConflictDoNothing();
    await db
      .insert(portfolioSnapshots)
      .values(snapshots)
      .onConflictDoUpdate({
        target: [portfolioSnapshots.userId, portfolioSnapshots.day],
        set: { positionsValueUsd: sql`excluded.positions_value_usd` },
        setWhere: isNull(portfolioSnapshots.positionsValueUsd),
      });
    const thesisId = seedId(1, index);
    const versionId = seedId(4, index);
    const [entry] = await db
      .select({ id: trades.id })
      .from(trades)
      .where(and(eq(trades.userId, profile.id), eq(trades.signature, `demo:${profile.handle}:2`)));
    await db
      .insert(theses)
      .values({
        id: thesisId,
        userId: profile.id,
        mint,
        wallet: profile.walletAddress,
        positionId: entry!.id,
        viewCount: 84 + index * 23,
      })
      .onConflictDoUpdate({
        target: theses.id,
        set: { viewCount: sql`excluded.view_count` },
        setWhere: eq(theses.viewCount, 0),
      });
    if (imageUrl)
      await db
        .update(tokens)
        .set({ imageUrl })
        .where(and(eq(tokens.mint, mint), isNull(tokens.imageUrl)));
    const peer = profiles[followGraph[index]![0]!]!;
    await db
      .insert(comments)
      .values([
        {
          id: versionId,
          thesisId,
          pinned: index % 4 === 0,
          userId: profile.id,
          mint,
          kind: "thesis",
          position: "long",
          body: traders[index]![3],
          createdAt: new Date((anchor - 180 - index * 60) * 1000),
        },
        {
          id: seedId(2, index),
          thesisId,
          userId: profile.id,
          mint,
          kind: "thesis",
          position: "long",
          body: `Building a ${symbol} starter in two clips. Risk is defined at the prior session low, not at my average entry.`,
          createdAt: new Date((anchor - 4 * day + 60 - index * 60) * 1000),
        },
        {
          id: seedId(3, index),
          userId: peer.id,
          mint,
          thesisId,
          parentId: versionId,
          body: replies[index % replies.length]!,
          createdAt: new Date((anchor - 120 - index * 60) * 1000),
        },
      ])
      .onConflictDoNothing();
    await db
      .insert(reactions)
      .values(
        followGraph[index]!.map((target) => ({
          postId: versionId,
          userId: profiles[target]!.id,
        })),
      )
      .onConflictDoNothing();
  }
  await db
    .insert(follows)
    .values(
      followGraph.flatMap((targets, index) =>
        targets.map((target) => ({
          followerId: profiles[index]!.id,
          followeeWallet: profiles[target]!.walletAddress,
          createdAt: new Date((anchor - 30 * day) * 1000),
        })),
      ),
    )
    .onConflictDoNothing();

  const recipient = profiles[0]!;
  const [thesis] = await db
    .select()
    .from(theses)
    .where(eq(theses.id, seedId(1, 0)));
  const activityFills = await db.select().from(trades).where(eq(trades.userId, profiles[1]!.id));
  const activity = activityFills.find(({ signature }) => signature === "demo:basispoints:5");
  const activityEpisode = positionEpisodes(activityFills).find(({ fills }) =>
    fills.some(({ id }) => id === activity?.id),
  );
  const at = (age: number) => new Date((anchor - age) * 1000);
  const shared = { recipientId: recipient.id, demo: true };
  const target = { wallet: thesis!.wallet, positionId: thesis!.positionId, thesisId: thesis!.id };
  await insertNotifications(db, [
    ...followGraph[0]!.map((index) => ({
      ...shared,
      eventKey: `demo:thesis-like:${index}`,
      groupKey: "thesis-like:demo",
      actorId: profiles[index]!.id,
      mint: mints[0]!,
      createdAt: at(90 + index),
      details: { kind: "thesis_like" as const, target: { ...target, commentId: seedId(4, 0) } },
    })),
    {
      ...shared,
      eventKey: "demo:thesis-comment",
      actorId: profiles[1]!.id,
      mint: mints[0]!,
      createdAt: at(120),
      details: { kind: "thesis_comment", target: { ...target, commentId: seedId(3, 0) } },
    },
    ...[1, 3, 5].map((index) => ({
      ...shared,
      eventKey: `demo:follow:${index}`,
      groupKey: "follow:demo",
      actorId: profiles[index]!.id,
      createdAt: at(300 + index),
      readAt: at(60),
      details: { kind: "follow" as const },
    })),
    {
      ...shared,
      eventKey: "demo:leaderboard",
      createdAt: at(7200),
      readAt: at(3500),
      details: { kind: "leaderboard", target: { window: "7d", rank: 3, previousRank: 6 } },
    },
    ...(activity
      ? [
          {
            ...shared,
            eventKey: "demo:trader-activity",
            actorId: activity.userId,
            mint: activity.mint,
            createdAt: activity.executedAt,
            details: {
              kind: "trader_trade" as const,
              target: {
                wallet: profiles[1]!.walletAddress,
                positionId: activityEpisode?.id ?? null,
                sizeUsd: Number(activity.quoteAmountUsd),
                side: activity.side,
              },
            },
          },
        ]
      : []),
  ]);
}
