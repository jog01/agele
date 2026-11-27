import { setTimeout } from "node:timers/promises";
import { getBase58Decoder } from "@solana/kit";
import { hash, mulberry32 } from "../../lib/prng";
import { SOL_MINT } from "../helius-parser";
import type { ChainFacts, SolUsdPrice } from "./chain-facts";
import type { ChainEvent, ChainEventSink, ChainEventSource, Market } from "./events";

const DECIMALS = 6;
const TOKEN_UNIT = 10n ** BigInt(DECIMALS);
const LAMPORTS = 1_000_000_000n;
const VIRTUAL_SOL = 30n * LAMPORTS;
const VIRTUAL_TOKENS = 1_073_000_000n * TOKEN_UNIT;
const GRADUATION = 85n * LAMPORTS;
const SUPPLY = 1_000_000_000n * TOKEN_UNIT;
const pumpProgram = "6EF8rrecthR5Dkzonxso9wC4DT6xKz3zZR3TS2RgC7g";
const swapProgram = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const prefixes = [
  "Pocket",
  "Solar",
  "Turbo",
  "Midnight",
  "Jelly",
  "Disco",
  "Peach",
  "Cloud",
  "Cosmic",
  "Lucky",
];
const mascots = [
  "Capybara",
  "Otter",
  "Raccoon",
  "Gecko",
  "Pigeon",
  "Mochi",
  "Panda",
  "Shiba",
  "Frog",
  "Duck",
];
const base58 = getBase58Decoder();

export class Curve {
  private sol = VIRTUAL_SOL;
  private tokens = VIRTUAL_TOKENS;
  private product = this.sol * this.tokens;
  private migrated = false;

  get progressBps() {
    return Number(((this.sol - VIRTUAL_SOL) * 10_000n) / GRADUATION);
  }

  buy(lamports: bigint) {
    const sol = this.migrated ? lamports : min(lamports, VIRTUAL_SOL + GRADUATION - this.sol);
    const nextSol = this.sol + sol;
    const nextTokens = (this.product + nextSol - 1n) / nextSol;
    const tokens = this.tokens - nextTokens;
    if (tokens <= 0n) return null;
    this.sol = nextSol;
    this.tokens = nextTokens;
    return { sol, tokens };
  }

  sell(tokens: bigint) {
    if (!this.migrated) tokens = min(tokens, VIRTUAL_TOKENS - this.tokens);
    const nextTokens = this.tokens + tokens;
    const nextSol = (this.product + nextTokens - 1n) / nextTokens;
    const sol = this.sol - nextSol;
    if (sol <= 0n) return null;
    this.sol = nextSol;
    this.tokens = nextTokens;
    return { sol, tokens };
  }

  migrate() {
    this.migrated = true;
    this.sol -= VIRTUAL_SOL;
    this.tokens = (this.sol * this.tokens) / (this.sol + VIRTUAL_SOL);
    this.product = this.sol * this.tokens;
  }
}

function min(a: bigint, b: bigint) {
  return a < b ? a : b;
}

/** A time-addressable, mean-reverting walk is consistent across API and feed processes. */
export class DemoSolUsdPrice implements SolUsdPrice {
  getSolUsd(time: number) {
    const minute = Math.floor(time / 60);
    let delta = 0;
    for (let offset = 47; offset >= 0; offset--) {
      delta = 0.94 * delta + (mulberry32(hash(`demo-sol:${minute - offset}`))() - 0.5) * 2;
    }
    return 180 + delta;
  }
}

export const demoChainFacts: ChainFacts = {
  tokenSupply: async () => String(SUPPLY),
  blockTime: async (slot) => Math.floor(slot / 3),
};

type DemoToken = {
  mint: string;
  market: Market;
  curve: Curve;
  balances: Map<string, bigint>;
  heat: number;
  cooldownUntil: number;
};

type SimulatorOptions = {
  seed?: number;
  traders?: readonly string[];
  now?: () => number;
  historyHours?: number;
};

class Simulation {
  private readonly random: () => number;
  private readonly traders: readonly string[];
  private readonly tokens: DemoToken[] = [];
  private lastTime = -1;
  private tx = 0;
  private launches = 0;

  constructor(seed: number, traders?: readonly string[]) {
    this.random = mulberry32(seed);
    this.traders = traders?.length ? traders : Array.from({ length: 48 }, () => this.address());
  }

  private address(size = 32) {
    return base58.decode(Uint8Array.from({ length: size }, () => Math.floor(this.random() * 256)));
  }

  private pick<T>(items: readonly T[]) {
    return items[Math.floor(this.random() * items.length)]!;
  }

  private ref(mint: string, time: number) {
    if (this.lastTime !== time) {
      this.tx = 0;
      this.lastTime = time;
    }
    return {
      source: "demo" as const,
      mint,
      slot: time * 3,
      blockTime: time,
      signature: this.address(64),
      transactionIndex: this.tx++,
      eventIndex: 0,
    };
  }

  launch(time: number, hot = false): ChainEvent {
    const mint = this.address();
    const market: Market = { address: this.address(), venue: "pump.fun", programId: pumpProgram };
    const heat = this.launches++ % 4 === 0 || hot ? 0.97 : 0.15 + this.random() * 0.53;
    this.tokens.push({ mint, market, curve: new Curve(), balances: new Map(), heat, cooldownUntil: 0 });
    if (this.tokens.length > 48) this.tokens.shift();
    const prefix = this.pick(prefixes);
    const mascot = this.pick(mascots);
    const metadata = {
      name: `${prefix} ${mascot}`,
      symbol: `${prefix.slice(0, 2)}${mascot.slice(0, 4)}`.toUpperCase(),
      image: `https://api.dicebear.com/9.x/bottts-neutral/png?seed=${mint}`,
    };
    return {
      ...this.ref(mint, time),
      kind: "TokenLaunched",
      market,
      creator: this.pick(this.traders),
      decimals: DECIMALS,
      metadataUri: `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`,
    };
  }

  coolOff(mint: string, until: number) {
    const token = this.tokens.find((entry) => entry.mint === mint);
    if (token) token.cooldownUntil = until;
  }

  trade(time: number, momentumMint?: string): ChainEvent[] {
    if (!this.tokens.length) return [];
    const active = this.tokens.filter((t) => t.market.venue === "pump.fun" && t.heat > 0.9);
    const migrated = this.tokens.filter((t) => t.market.venue === "pumpswap");
    const roll = this.random();
    const momentum = momentumMint ? this.tokens.find((entry) => entry.mint === momentumMint) : undefined;
    const token =
      momentum ??
      (roll < 0.45 && active.length
        ? this.pick(active)
        : roll < 0.68 && migrated.length
          ? this.pick(migrated)
          : this.pick(this.tokens));
    const trader = this.pick(this.traders);
    const balance = token.balances.get(trader) ?? 0n;
    const onCurve = token.market.venue === "pump.fun";
    const coolingOff = time < token.cooldownUntil;
    const sell = !momentumMint && balance > 0n && this.random() < (onCurve ? 1 - token.heat : 0.57);
    const budget = momentumMint
      ? 5.15 + this.random() * 0.7
      : coolingOff
        ? 0.005 + this.random() * 0.035
        : onCurve && token.heat > 0.9
          ? 2 + this.random() * 5
          : 0.03 + this.random() * 1.8;
    const salePct = sell ? (coolingOff ? 1 : 10 + Math.floor(this.random() * 50)) : 0;
    const fill = sell
      ? token.curve.sell((balance * BigInt(salePct)) / 100n)
      : token.curve.buy(BigInt(Math.floor(budget * Number(LAMPORTS))));
    if (!fill) return [];
    token.balances.set(trader, balance + (sell ? -fill.tokens : fill.tokens));
    const ref = this.ref(token.mint, time);
    const events: ChainEvent[] = [
      {
        ...ref,
        kind: "Trade",
        market: token.market,
        trader,
        side: sell ? "sell" : "buy",
        base: { mint: token.mint, raw: String(fill.tokens), decimals: DECIMALS },
        quote: { mint: SOL_MINT, raw: String(fill.sol), decimals: 9 },
        ...(onCurve ? { curveProgressBps: token.curve.progressBps } : {}),
      },
    ];
    if (onCurve && token.curve.progressBps >= 10_000) {
      const pool: Market = { address: this.address(), venue: "pumpswap", programId: swapProgram };
      events.push({ ...ref, eventIndex: 1, kind: "Migrated", from: token.market, to: pool });
      token.market = pool;
      token.curve.migrate();
    }
    return events;
  }

  launchDelay() {
    return 5 + Math.floor(this.random() * 8);
  }
}

export class DemoChainSimulator implements ChainEventSource {
  constructor(private readonly options: SimulatorOptions = {}) {}

  async run(sink: ChainEventSink, signal: AbortSignal) {
    const now = () => Math.floor((this.options.now ?? Date.now)() / 1000);
    const start = now();
    const origin = Math.floor(start / 300) * 300;
    const sim = new Simulation(this.options.seed ?? hash(`demo:${origin}`), this.options.traders);
    const originHistory = origin - (this.options.historyHours ?? 3) * 3600;
    let pending: ChainEvent[] = [];
    let momentumMint: string | undefined;
    for (let time = originHistory; time < origin && !signal.aborted; time += 12) {
      if ((time - originHistory) % 432 === 0) pending.push(sim.launch(time));
      if (time === origin - 144) {
        const launch = sim.launch(time, true);
        pending.push(launch);
        momentumMint = launch.mint;
      }
      if (momentumMint) pending.push(...sim.trade(time, momentumMint));
      else pending.push(...sim.trade(time), ...sim.trade(time));
      if (pending.length >= 100) {
        await sink.ingest(pending);
        pending = [];
      }
    }
    if (signal.aborted) return;
    if (pending.length) await sink.ingest(pending);
    if (momentumMint) sim.coolOff(momentumMint, now() + 180);
    let nextLaunch = now();
    while (!signal.aborted) {
      const time = now();
      const events: ChainEvent[] = [];
      if (time >= nextLaunch) {
        events.push(sim.launch(time));
        nextLaunch = time + sim.launchDelay();
      }
      events.push(...sim.trade(time), ...sim.trade(time));
      if (events.length) await sink.ingest(events);
      try {
        await setTimeout(950, undefined, { signal });
      } catch (err) {
        if (!signal.aborted) throw err;
      }
    }
  }
}
