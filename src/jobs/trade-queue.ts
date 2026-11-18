import { createHash } from "node:crypto";
import type { EnhancedTransaction } from "../services/helius-parser";
import { getQueue, QUEUE } from "./queues";

export interface TradeQueue {
  enqueue(transactions: EnhancedTransaction[]): Promise<{ queued: number }>;
}

/** One job per webhook batch, ordered by timestamp, so a wallet's buy is recorded before its sell. */
export async function enqueueTrades(transactions: EnhancedTransaction[]) {
  if (!transactions.length) return { queued: 0 };
  const ordered = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  const jobId = createHash("sha256")
    .update(ordered.map((tx) => tx.signature).join(","))
    .digest("hex");
  await getQueue(QUEUE.tradeIndex).add("index", ordered, {
    jobId,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 7 * 86_400 },
    removeOnFail: { age: 30 * 86_400 },
  });
  return { queued: transactions.length };
}
