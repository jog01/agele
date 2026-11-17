import { hash, mulberry32 } from "../../lib/prng";
import type { CommentDto, LeaderboardEntryDto, LeaderboardWindowValue } from "../../schemas/social";
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
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
      const wallet = Array.from({ length: 44 }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join(
        "",
      );
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
