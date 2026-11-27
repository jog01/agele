import type { Env } from "../../config/env";
import { getDb } from "../../db/client";
import type { ChainFacts, SolUsdPrice } from "./chain-facts";
import { readDemoState } from "./demo-state";
import type { ChainEventSource } from "./events";
import { DemoChainSimulator, DemoSolUsdPrice, demoChainFacts } from "./simulator";

interface ChainIngest {
  source: ChainEventSource;
  solUsd: SolUsdPrice;
  facts: ChainFacts;
}

export function createChainIngest(env: Pick<Env, "CHAIN_SOURCE">): ChainIngest {
  switch (env.CHAIN_SOURCE) {
    case "demo":
      return {
        source: new DemoChainSimulator({ loadState: () => readDemoState(getDb()) }),
        solUsd: new DemoSolUsdPrice(),
        facts: demoChainFacts,
      };
    // Register the Solana source here with JupiterSolUsdPrice and RpcChainFacts(env.SOLANA_RPC_URL)
    // when the Yellowstone adapter is available.
  }
}
