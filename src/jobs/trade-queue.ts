import type { EnhancedTransaction } from "../services/helius-parser";
import { getQueue, QUEUE } from "./queues";

export interface TradeQueue {
  enqueue(transactions: EnhancedTransaction[]): Promise<{ queued: number }>;
}

export async function enqueueTrades(transactions: EnhancedTransaction[]) {
  if (transactions.length)
    await getQueue(QUEUE.tradeIndex).addBulk(
      transactions.map((transaction) => ({
        name: "index",
        data: transaction,
        opts: {
          jobId: transaction.signature,
          attempts: 5,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: { age: 7 * 86_400 },
          removeOnFail: { age: 30 * 86_400 },
        },
      })),
    );
  return { queued: transactions.length };
}
