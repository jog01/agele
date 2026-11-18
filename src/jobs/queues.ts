import { Queue } from "bullmq";
import { getRedis } from "../lib/redis";

export const QUEUE = {
  tradeIndex: "trade-index",
  leaderboardRebuild: "leaderboard-rebuild",
  portfolioSnapshot: "portfolio-snapshot",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName) {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getRedis() });
    queues.set(name, q);
  }
  return q;
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
