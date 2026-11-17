import { getBase58Decoder } from "@solana/kit";
import { hash, mulberry32 } from "../../lib/prng";
import type {
  CommentDto,
  FeedItemDto,
  LeaderboardEntryDto,
  LeaderboardWindowValue,
} from "../../schemas/social";
import { encodeCursor, type FeedCursor } from "./cursor";
import type { SocialProvider } from "./provider";

const HANDLES = [
  "frostbyte",
  "solsurfer",
  "glacier",
  "degenlord",
  "orca_whale",
  "nightdesk",
  "kelvin",
  "mintmaxi",
  "tapehead",
  "icecap",
  "lowcap_larry",
  "basedmike",
  "jitoboy",
  "slippage",
  "cold_wallet",
  "rugdodger",
  "sniper.sol",
  "permafrost",
  "aurora",
  "bidwall",
  "theta",
  "graphite",
  "deepbook",
  "candlewick",
];
function walletFor(handle: string) {
  const rand = mulberry32(hash(handle));
  return getBase58Decoder().decode(Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256)));
}
const WINDOW_SCALE: Record<LeaderboardWindowValue, number> = { "24h": 1, "7d": 4.2, "30d": 13 };
const THESES = [
  "Volume is rotating in hard, holding through the next leg.",
  "Liquidity looks thin above here, trimming into strength.",
  "Clean higher lows on the 1h, adding on dips.",
  "Top wallets are accumulating, following the smart money.",
  "Funding flipped, expecting a squeeze.",
  "Took profit, will re-enter on a retest.",
  "Chart is cooked short term but the narrative is strong.",
  "Just aped a small bag, risk managed.",
];

export class MockSocialProvider implements SocialProvider {
  constructor(private readonly now: () => number = () => Date.now()) {}

  async leaderboard(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardEntryDto[]> {
    const scale = WINDOW_SCALE[window];
    const rows = HANDLES.map((handle) => {
      const rand = mulberry32(hash(`${handle}:${window}`));
      const wallet = walletFor(handle);
      const volumeUsd = Math.round(10 ** (4 + rand() * 2.5) * scale);
      const pnlPct = (rand() * 1.4 - 0.25) * 100 * Math.sqrt(scale);
      return {
        wallet,
        handle,
        volumeUsd,
        pnlPct,
        pnlUsd: (volumeUsd * pnlPct) / 400,
        trades: Math.floor((20 + rand() * 400) * scale),
        winRatePct: 35 + rand() * 45,
      };
    });
    return rows
      .sort((a, b) => b.pnlUsd - a.pnlUsd)
      .slice(0, limit)
      .map((r, i) => ({ rank: i + 1, ...r }));
  }

  async feed({ wallets, cursor, limit }: { wallets?: string[]; cursor?: FeedCursor; limit: number }) {
    const allowed = wallets === undefined ? undefined : new Set(wallets);
    const rows: FeedItemDto[] = Array.from({ length: HANDLES.length * 4 }, (_, i) => {
      const handle = HANDLES[i % HANDLES.length]!;
      const common = {
        id: `demo-${i.toString().padStart(4, "0")}`,
        handle,
        wallet: walletFor(handle),
        mint: "So11111111111111111111111111111111111111112",
        position: (["long", "short", "none"] as const)[i % 3]!,
        createdAt: 1767268800 - Math.floor(i / 2) * 60,
      };
      return i % 2 === 0
        ? { ...common, kind: "thesis", body: THESES[i % THESES.length]! }
        : { ...common, kind: "trade", side: i % 4 === 1 ? "buy" : "sell", amountUsd: 100 + i * 37 };
    });
    const matching = rows
      .filter(
        (row) =>
          (!allowed || allowed.has(row.wallet)) &&
          (!cursor ||
            row.createdAt < cursor.createdAt ||
            (row.createdAt === cursor.createdAt && row.id < cursor.id)),
      )
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const items = matching.slice(0, limit);
    return { items, nextCursor: matching.length > limit ? encodeCursor(items[items.length - 1]!) : null };
  }

  async comments(mint: string, limit: number): Promise<CommentDto[]> {
    const nowSec = Math.floor(this.now() / 1000);
    const rand = mulberry32(hash(mint));
    return Array.from({ length: Math.min(limit, 12) }, (_, i) => {
      const r = rand();
      return {
        id: `${hash(`${mint}:${i}`).toString(36)}`,
        mint,
        handle: HANDLES[Math.floor(r * HANDLES.length)]!,
        body: THESES[Math.floor(rand() * THESES.length)]!,
        position: r > 0.66 ? "short" : r > 0.2 ? "long" : "none",
        likes: Math.floor(rand() * 240),
        createdAt: nowSec - Math.floor((i + rand()) * 1800),
      } satisfies CommentDto;
    });
  }
}
