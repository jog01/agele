import { z } from "zod";

export interface ChainFacts {
  tokenSupply(mint: string): Promise<string>;
  blockTime(slot: number): Promise<number>;
}

export interface SolUsdPrice {
  getSolUsd(time: number): number | Promise<number>;
}

const supply = z.object({ value: z.object({ amount: z.string().regex(/^\d+$/) }) });

export class RpcChainFacts implements ChainFacts {
  constructor(private readonly url: string) {}

  private async request<T>(method: string, params: unknown[], schema: z.ZodType<T>) {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error();
      return z.object({ result: schema }).parse(await response.json()).result;
    } catch {
      throw new Error(`Solana RPC ${method} unavailable`);
    }
  }

  async tokenSupply(mint: string) {
    return (await this.request("getTokenSupply", [mint], supply)).value.amount;
  }

  blockTime(slot: number) {
    return this.request("getBlockTime", [slot], z.int().nonnegative());
  }
}
