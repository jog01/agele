export type Venue =
  | "pump.fun"
  | "pumpswap"
  | "raydium-v4"
  | "raydium-cpmm"
  | "raydium-clmm"
  | "meteora-dlmm"
  | "meteora-damm";

export type Market = { address: string; venue: Venue; programId: string };
export type Amount = { mint: string; raw: string; decimals: number };

export type EventRef = {
  source: "demo" | "solana";
  signature: string;
  slot: number;
  transactionIndex: number;
  eventIndex: number;
  blockTime: number | null;
  mint: string;
};

export type ChainEvent = EventRef &
  (
    | { kind: "TokenLaunched"; market: Market; creator: string; decimals: number; metadataUri?: string }
    | {
        kind: "Trade";
        market: Market;
        trader: string;
        side: "buy" | "sell";
        base: Amount;
        quote: Amount;
        curveProgressBps?: number;
      }
    | { kind: "Migrated"; from: Market; to: Market }
  );

export interface ChainEventSink {
  ingest(events: readonly ChainEvent[]): Promise<void>;
}

export interface ChainEventSource {
  run(sink: ChainEventSink, signal: AbortSignal): Promise<void>;
}
