import type { Env } from "../../config/env";
import { getDb } from "../../db/client";
import { LiveMarketDataProvider } from "../market-data/live.provider";
import { type ChainFacts, RpcChainFacts, type SolUsdPrice } from "./chain-facts";
import { readDemoState } from "./demo-state";
import type { ChainEventSource } from "./events";
import { JupiterSolUsdPrice } from "./jupiter-sol-usd-price";
import { DemoChainSimulator, DemoSolUsdPrice, demoChainFacts } from "./simulator";
import { createMarketChainSource } from "./source";

interface ChainIngest {
  source: ChainEventSource;
  solUsd: SolUsdPrice;
  facts: ChainFacts;
}

export function createChainIngest(
  env: Pick<
    Env,
    "CHAIN_SOURCE" | "JUPITER_API_KEY" | "SOLANA_RPC_URL" | "YELLOWSTONE_GRPC_URL" | "YELLOWSTONE_GRPC_TOKEN"
  >,
): ChainIngest {
  const simulator = new DemoChainSimulator({ loadState: () => readDemoState(getDb()) });
  const source = createMarketChainSource(simulator, env);
  return env.CHAIN_SOURCE === "solana"
    ? {
        source,
        solUsd: new JupiterSolUsdPrice(new LiveMarketDataProvider({ jupiterApiKey: env.JUPITER_API_KEY })),
        facts: new RpcChainFacts(env.SOLANA_RPC_URL),
      }
    : { source, solUsd: new DemoSolUsdPrice(), facts: demoChainFacts };
}
