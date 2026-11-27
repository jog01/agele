import { createHash } from "node:crypto";
import type { Venue } from "./events";

export const PROGRAMS = {
  pump: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  raydiumV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  raydiumCpmm: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  raydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  meteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  meteoraDammV1: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  meteoraDammV2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
} as const;

export const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
export const SOL = "So11111111111111111111111111111111111111112";
export const SYSTEM = "11111111111111111111111111111111";
export const QUOTES = [
  SOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
];

export const discriminator = (namespace: "global" | "event", name: string) =>
  createHash("sha256").update(`${namespace}:${name}`).digest("hex").slice(0, 16);
export const calls = (...names: string[]) => new Set(names.map((name) => discriminator("global", name)));
export const tag = (data: Buffer) => data.toString("hex", 0, 8);

type SwapLayout = {
  venue: Venue;
  pool: number;
  trader: number;
  input: number;
  output: number;
  vaults: readonly [number, number];
  inputFee?: number;
};

const layouts = new Map<string, { instructions: Set<string>; layout: SwapLayout }>([
  [
    PROGRAMS.raydiumCpmm,
    {
      instructions: calls("swap_base_input", "swap_base_output"),
      layout: { venue: "raydium-cpmm", pool: 3, trader: 0, input: 4, output: 5, vaults: [6, 7] },
    },
  ],
  [
    PROGRAMS.raydiumClmm,
    {
      instructions: calls("swap", "swap_v2"),
      layout: { venue: "raydium-clmm", pool: 2, trader: 0, input: 3, output: 4, vaults: [5, 6] },
    },
  ],
  [
    PROGRAMS.meteoraDlmm,
    {
      instructions: calls(
        "swap",
        "swap2",
        "swap_exact_out",
        "swap_exact_out2",
        "swap_with_price_impact",
        "swap_with_price_impact2",
      ),
      layout: { venue: "meteora-dlmm", pool: 0, trader: 10, input: 4, output: 5, vaults: [2, 3] },
    },
  ],
  [
    PROGRAMS.meteoraDammV1,
    {
      instructions: calls("swap"),
      layout: {
        venue: "meteora-damm",
        pool: 0,
        trader: 12,
        input: 1,
        output: 2,
        vaults: [5, 6],
        inputFee: 11,
      },
    },
  ],
  [
    PROGRAMS.meteoraDammV2,
    {
      instructions: calls("swap", "swap2"),
      layout: { venue: "meteora-damm", pool: 1, trader: 8, input: 2, output: 3, vaults: [4, 5] },
    },
  ],
]);

export function swapLayout(programId: string, data: Buffer, accounts: number): SwapLayout | undefined {
  if (programId === PROGRAMS.raydiumV4) {
    if (data.length < 17) return;
    if ((data[0] === 9 || data[0] === 11) && (accounts === 17 || accounts === 18)) {
      return {
        venue: "raydium-v4",
        pool: 1,
        trader: accounts - 1,
        input: accounts - 3,
        output: accounts - 2,
        vaults: [accounts - 13, accounts - 12],
      };
    }
    if ((data[0] === 16 || data[0] === 17) && accounts === 8) {
      return { venue: "raydium-v4", pool: 1, trader: 7, input: 5, output: 6, vaults: [3, 4] };
    }
    return;
  }
  const entry = layouts.get(programId);
  if (entry?.instructions.has(tag(data))) return entry.layout;
}
