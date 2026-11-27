import Client, {
  CommitmentLevel,
  type SubscribeRequest,
  type SubscribeUpdate,
} from "@triton-one/yellowstone-grpc";
import { logger } from "../../lib/logger";
import { type CurveReserveStore, curveProgress } from "./curve-progress";
import { decodeTransaction } from "./decode";
import type { ChainEventSink, ChainEventSource } from "./events";
import { PROGRAMS } from "./programs";
import { nonnegativeInteger, normalizeTransaction } from "./transaction";

type Stream = AsyncIterable<SubscribeUpdate> & {
  write(request: SubscribeRequest, callback: (error?: Error | null) => void): boolean;
  cancel(): void;
};

export interface SlotCheckpoint {
  load(): Promise<number | undefined>;
  advance(nextSlot: number): Promise<void>;
}

type Subscription = { stream: Stream; close(): void };
type Connect = () => Promise<Subscription>;

function subscription(fromSlot?: number): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {
      dex: {
        accountInclude: Object.values(PROGRAMS),
        includeTransactions: true,
        includeAccounts: false,
        includeEntries: false,
      },
    },
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.FINALIZED,
    fromSlot: fromSlot?.toString(),
  };
}

function write(stream: Stream, request: SubscribeRequest) {
  return new Promise<void>((resolve, reject) =>
    stream.write(request, (error) => (error ? reject(error) : resolve())),
  );
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function grpcConnection(endpoint: string, token: string): Connect {
  return async () => {
    const client = new Client(endpoint, token, {
      "grpc.max_receive_message_length": 32 * 1024 * 1024,
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
    });
    try {
      const stream = await client.subscribe();
      stream.on("error", () => {});
      return { stream, close: () => client._client.close() };
    } catch (error) {
      client._client.close();
      throw error;
    }
  };
}

export class YellowstoneSource implements ChainEventSource {
  constructor(
    private readonly connect: Connect,
    private readonly checkpoint: SlotCheckpoint,
    private readonly reserves: CurveReserveStore,
  ) {}

  async run(sink: ChainEventSink, signal: AbortSignal): Promise<void> {
    let nextSlot: number | undefined;
    let backoff = 250;
    while (!signal.aborted) {
      let active: Subscription | undefined;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => active?.stream.cancel();
      try {
        nextSlot ??= await this.checkpoint.load();
        if (signal.aborted) return;
        active = await this.connect();
        if (signal.aborted) return;
        signal.addEventListener("abort", cancel, { once: true });
        const { stream } = active;
        const messages = stream[Symbol.asyncIterator]();
        const open = subscription(nextSlot);
        idle = setTimeout(cancel, 60_000);
        await write(stream, open);
        while (!signal.aborted) {
          const { value: update, done } = await messages.next();
          clearTimeout(idle);
          if (done || signal.aborted) break;
          if (update.ping) {
            idle = setTimeout(cancel, 60_000);
            await write(stream, {
              accounts: {},
              slots: {},
              transactions: {},
              transactionsStatus: {},
              blocks: {},
              blocksMeta: {},
              entry: {},
              accountsDataSlice: [],
              ping: { id: 1 },
            });
          } else if (update.block) {
            const block = update.block;
            const slot = nonnegativeInteger(block.slot);
            const parent = nonnegativeInteger(block.parentSlot);
            if (slot === undefined || parent === undefined || slot === Number.MAX_SAFE_INTEGER) {
              throw new Error("Invalid Yellowstone block slot");
            }
            if (nextSlot === undefined || slot >= nextSlot) {
              if (nextSlot !== undefined && parent >= nextSlot) throw new Error("Yellowstone replay gap");
              if (nextSlot === undefined) {
                await this.checkpoint.advance(slot);
                nextSlot = slot;
              }
              const timestamp = block.blockTime && nonnegativeInteger(block.blockTime.timestamp);
              const decoded = block.transactions
                .flatMap((tx) => {
                  const normalized = normalizeTransaction(tx, slot, timestamp ?? null);
                  return normalized ? decodeTransaction(normalized) : [];
                })
                .sort(
                  (a, b) =>
                    a.event.transactionIndex - b.event.transactionIndex ||
                    a.event.eventIndex - b.event.eventIndex,
                );
              if (decoded.length) await sink.ingest(await curveProgress(decoded, this.reserves));
              await this.checkpoint.advance(slot + 1);
              nextSlot = slot + 1;
              backoff = 250;
            }
          }
          clearTimeout(idle);
          idle = setTimeout(cancel, 60_000);
        }
        if (!signal.aborted) throw new Error("Yellowstone subscription ended");
      } catch (error) {
        if (!signal.aborted) {
          logger.warn(
            { nextSlot, code: grpcStatus(error) },
            "Yellowstone ingestion interrupted; retrying from checkpoint",
          );
        }
      } finally {
        clearTimeout(idle);
        signal.removeEventListener("abort", cancel);
        active?.stream.cancel();
        active?.close();
      }
      await wait(backoff + Math.floor((Math.random() * backoff) / 4), signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

function grpcStatus(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
}
