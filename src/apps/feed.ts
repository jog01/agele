import { env } from "../config/env";
import { closeDb, getDb } from "../db/client";
import { guardLiveStartup } from "../db/live-data-guard";
import { ActiveTopicRegistry } from "../events/active-topics";
import { RedisEventPublisher } from "../events/bus";
import { FeedLock } from "../events/feed-lock";
import { logger } from "../lib/logger";
import { closeRedis, getRedis } from "../lib/redis";
import { createChainIngest } from "../services/chain-ingest";
import type { ChainEventSink } from "../services/chain-ingest/events";
import { IngestService } from "../services/chain-ingest/service";
import { createMarketDataProvider } from "../services/market-data";
import { startPriceFeed } from "../ws/price-feed";

await guardLiveStartup();
const redis = getRedis();
const lock = new FeedLock(redis);
const registry = new ActiveTopicRegistry(redis);
const events = new RedisEventPublisher();
const market = createMarketDataProvider();
let owner: { controller: AbortController; running: Promise<void>; stopPrices: () => void } | undefined;
let stopping = false;
let election: Promise<void> | undefined;

async function stopOwner() {
  const previous = owner;
  owner = undefined;
  if (!previous) return;
  previous.controller.abort();
  previous.stopPrices();
  await previous.running;
  await lock.release();
}

function startOwner() {
  const controller = new AbortController();
  const signal = controller.signal;
  const start = Math.floor(Date.now() / 1000);
  let live = false;
  const publisher = {
    publish: async (topic: string, data: unknown) => {
      if (live && !signal.aborted) await events.publish(topic, data);
    },
  };
  const { source, solUsd, facts } = createChainIngest(env);
  const ingest = new IngestService(getDb(), publisher, solUsd, facts);
  const marketSink: ChainEventSink = {
    ingest: async (batch) => {
      signal.throwIfAborted();
      if (!(await lock.renew())) controller.abort(new Error("Feed lease lost"));
      signal.throwIfAborted();
      live ||= batch.some((event) => (event.blockTime ?? 0) >= start);
      await ingest.ingest(batch);
    },
  };
  const running = source.run(marketSink, signal).catch((err) => {
    if (signal.aborted) return;
    controller.abort();
    logger.warn({ err }, "Chain source stopped");
  });
  const stopPrices = startPriceFeed(
    {
      activeTopics: () => (signal.aborted ? [] : registry.activeTopics()),
      publish: async (topic, data) => {
        if (!signal.aborted && (await lock.renew())) await events.publish(topic, data);
      },
    },
    { getToken: (mint) => market.getExternalToken(mint) },
  );
  owner = { controller, running, stopPrices };
}

async function elect() {
  try {
    if (owner && (owner.controller.signal.aborted || !(await lock.renew()))) await stopOwner();
    if (!stopping && !owner && (await lock.acquire())) {
      startOwner();
      logger.info({ source: env.CHAIN_SOURCE }, "Feed lock acquired");
    }
  } catch (err) {
    try {
      await stopOwner();
    } catch {}
    logger.warn({ err }, "Feed lock unavailable");
  }
}

function tick() {
  election ??= elect().finally(() => {
    election = undefined;
  });
}

tick();
const timer = setInterval(tick, 3000);
logger.info("feed started (standby unless lock owner)");
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  try {
    await election;
    await stopOwner();
  } finally {
    await Promise.all([events.close(), closeRedis(), closeDb()]);
  }
}
process.on("SIGINT", () => {
  void shutdown().catch((err) => logger.warn({ err }, "Feed shutdown failed"));
});
process.on("SIGTERM", () => {
  void shutdown().catch((err) => logger.warn({ err }, "Feed shutdown failed"));
});
