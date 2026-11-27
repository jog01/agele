import type { Env } from "../../config/env";
import type { ChainFacts, SolUsdPrice } from "./chain-facts";
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
      return { source: new DemoChainSimulator(), solUsd: new DemoSolUsdPrice(), facts: demoChainFacts };
    // Register the Solana source here with JupiterSolUsdPrice and RpcChainFacts(env.SOLANA_RPC_URL)
    // when the Yellowstone adapter is available.
  }
}
