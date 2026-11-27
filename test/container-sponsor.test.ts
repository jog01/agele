import { expect, it } from "bun:test";
import { env } from "../src/config/env";
import { createContainer } from "../src/container";
import { SOL_MINT } from "../src/services/helius-parser";
import { ValidatedFeeSponsor } from "../src/services/sponsor/validated-fee-sponsor";

it("wires live quotes for a configured sponsor with indexed market data", () => {
  const { SPONSOR_ENABLED, FEE_PAYER_PUBKEY, FEE_PAYER_SECRET, MARKET_DATA_PROVIDER } = env;
  try {
    env.SPONSOR_ENABLED = true;
    env.FEE_PAYER_PUBKEY = SOL_MINT;
    env.FEE_PAYER_SECRET = "unused-test-placeholder";
    env.MARKET_DATA_PROVIDER = "indexed";
    const { market, feeSponsor } = createContainer();
    expect(market.name).toBe("indexed");
    expect(feeSponsor).toBeInstanceOf(ValidatedFeeSponsor);
    expect(Reflect.get(feeSponsor, "options").market.name).toBe("live");
  } finally {
    Object.assign(env, { SPONSOR_ENABLED, FEE_PAYER_PUBKEY, FEE_PAYER_SECRET, MARKET_DATA_PROVIDER });
  }
});
