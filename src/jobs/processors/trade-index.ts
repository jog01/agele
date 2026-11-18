import type { Job } from "bullmq";
import type { EnhancedTransaction } from "../../services/helius-parser";
import type { TradeIndexer } from "../../services/trade-indexer";

export function createTradeIndexProcessor(indexer: Pick<TradeIndexer, "index">) {
  return (job: Pick<Job<EnhancedTransaction[]>, "data">) => indexer.index(job.data);
}
