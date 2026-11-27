import { env } from "../../config/env";
import { getRedis } from "../../lib/redis";
import type { ChainEventSource } from "./events";
import { nonnegativeInteger } from "./transaction";
import { grpcConnection, YellowstoneSource } from "./yellowstone";

const checkpointKey = "agele:chain:solana-mainnet:yellowstone:next-slot";
const curveStartsKey = "agele:chain:solana-mainnet:yellowstone:curve-starts";

export function createMarketChainSource(
  demo: ChainEventSource,
  config: { YELLOWSTONE_GRPC_URL?: string; YELLOWSTONE_GRPC_TOKEN?: string } = env,
): ChainEventSource {
  const { YELLOWSTONE_GRPC_URL: endpoint, YELLOWSTONE_GRPC_TOKEN: token } = config;
  if (!endpoint || !token) return demo;
  return new YellowstoneSource(
    grpcConnection(endpoint, token),
    {
      async load() {
        const saved = await getRedis().get(checkpointKey);
        if (saved === null) return;
        const slot = nonnegativeInteger(saved);
        if (slot === undefined) throw new Error("Invalid Yellowstone checkpoint");
        return slot;
      },
      async advance(nextSlot) {
        await getRedis().eval(
          "local saved = redis.call('GET', KEYS[1]); if not saved or tonumber(saved) < tonumber(ARGV[1]) then redis.call('SET', KEYS[1], ARGV[1]); end",
          1,
          checkpointKey,
          nextSlot,
        );
      },
    },
    {
      async load(curves) {
        const saved = await getRedis().hmget(curveStartsKey, ...curves);
        const starts = new Map<string, bigint>();
        for (const [index, curve] of curves.entries()) {
          const value = saved[index];
          if (value && /^\d+$/.test(value)) starts.set(curve, BigInt(value));
        }
        return starts;
      },
      async remember(starts) {
        const fields = [...starts].flatMap(([curve, amount]) => [curve, amount.toString()]);
        await getRedis().hset(curveStartsKey, ...fields);
      },
    },
  );
}
