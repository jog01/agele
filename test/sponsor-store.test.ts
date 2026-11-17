import { afterAll, expect, it, mock } from "bun:test";
import Redis from "ioredis";
import { LiveMarketDataProvider } from "../src/services/market-data/live.provider";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import {
  type IssuedRecord,
  MemorySponsorStore,
  RedisSponsorStore,
  SPONSOR_KILL_KEY,
} from "../src/services/sponsor/issued-store";
import { SWAP_MINTS_V01 as MINTS } from "../src/services/sponsor/swap-mints";
import { ValidatedFeeSponsor } from "../src/services/sponsor/validated-fee-sponsor";
import priceFixture from "./fixtures/jupiter-prices.json";
import tokenFixture from "./fixtures/jupiter-tokens.json";
import { sponsorSetup } from "./sponsor-helpers";

let now = 1_000_000;
function record(userId: string = crypto.randomUUID()): IssuedRecord {
  const id = crypto.randomUUID();
  return {
    id,
    context: {
      userId,
      requestId: id,
      wallet: "11111111111111111111111111111111",
      kind: "swap",
      swap: {
        inputMint: "input",
        outputMint: "output",
        inAmount: "100",
        otherAmountThreshold: "99",
        router: "metis",
        lastValidBlockHeight: "200",
      },
    },
    messageHash: "hash",
    lastValidBlockHeight: 200,
    expectedFeeLamports: "10000",
    expectedRentLamports: "0",
    createdAt: now,
    expiresAt: now + 30_000,
    state: "issued",
  };
}
it("limits open records, transactions per minute/day, user lamports and daily circuit breaker", async () => {
  for (const mode of ["open", "minute", "day", "lamports", "global"] as const) {
    now = 1_000_000;
    const store = new MemorySponsorStore(() => now, mode === "global" ? 10n : 1_000_000_000n),
      user = crypto.randomUUID();
    const count = mode === "open" ? 3 : mode === "day" ? 200 : mode === "minute" ? 10 : 1;
    for (let n = 0; n < count; n++) {
      if (mode === "day") now += 60_000;
      const r = record(user);
      await store.issue(r);
      if (mode !== "open")
        await store.claim(r, mode === "lamports" ? 50_000_000n : mode === "global" ? 10n : 1n);
    }
    const extra = record(user);
    await expect(
      mode === "open" ? store.issue(extra) : store.issue(extra).then(() => store.claim(extra, 1n)),
    ).rejects.toMatchObject({ reason: mode === "global" ? "kill_switch" : "quota" });
  }
});
it("deduplicates failure reports, suspends after five in ten minutes and expires the suspension", async () => {
  now = 1_000_000;
  const store = new MemorySponsorStore(() => now),
    user = crypto.randomUUID();
  for (let n = 0; n < 5; n++) {
    const r = record(user);
    await store.issue(r);
    await store.claim(r, 1n);
    await store.report(user, r.id, "submitted");
    await store.report(user, r.id, "failed");
    await store.report(user, r.id, "failed");
  }
  expect(store.failures.get(user)).toHaveLength(5);
  await expect(store.check(user)).rejects.toMatchObject({ reason: "quota" });
  now += 3_600_001;
  await expect(store.check(user)).resolves.toBeUndefined();
  store.killed = true;
  await expect(store.check(user)).rejects.toMatchObject({ reason: "kill_switch" });
});
it("fails closed when Redis is unavailable", async () => {
  const store = new RedisSponsorStore({
    eval: async () => {
      throw new Error("offline");
    },
    mget: async () => {
      throw new Error("offline");
    },
  } as unknown as Redis);
  await expect(store.check("user")).rejects.toMatchObject({ reason: "quota" });
  await expect(store.get("request")).rejects.toMatchObject({ reason: "record_missing" });
});

// Dedicated local test database; never connects to a configured remote service.
const redis = new Redis({
  host: "127.0.0.1",
  port: 6379,
  db: 15,
  lazyConnect: true,
  retryStrategy: () => null,
  maxRetriesPerRequest: 0,
});
afterAll(() => redis.disconnect());
it("executes Redis issue TTL, CAS, quotas, failure window and kill-switch Lua atomically", async () => {
  await redis.connect();
  const keys: string[] = [];
  const user = crypto.randomUUID();
  now = Date.now();
  const store = new RedisSponsorStore(redis, 100n, () => now);
  const tracked = (u: string = user) => {
    const r = record(u);
    keys.push(
      `sponsor:issued:${r.id}`,
      `sponsor:seen:${r.id}`,
      `sponsor:open:${u}`,
      `sponsor:suspended:${u}`,
      `sponsor:failed:${u}`,
      `sponsor:minute:${u}:${Math.floor(now / 60_000)}`,
      `sponsor:day:${u}:${Math.floor(now / 86_400_000)}`,
      `sponsor:lamports:${u}:${Math.floor(now / 86_400_000)}`,
      `sponsor:spend:${Math.floor(now / 86_400_000)}`,
    );
    return r;
  };
  // Refuse to clear an existing operator kill switch.
  expect(await redis.exists(SPONSOR_KILL_KEY)).toBe(0);
  try {
    const r = tracked();
    await store.issue(r);
    expect(await redis.pttl(`sponsor:issued:${r.id}`)).toBeGreaterThan(0);
    expect(await redis.pttl(`sponsor:issued:${r.id}`)).toBeLessThanOrEqual(30_000);
    expect((await store.get(r.id)).messageHash).toBe("hash");
    const claims = await Promise.allSettled([store.claim(r, 1n), store.claim(r, 1n)]);
    expect(claims.filter((c) => c.status === "fulfilled")).toHaveLength(1);
    expect(claims.find((c) => c.status === "rejected")).toMatchObject({ reason: { reason: "record_used" } });
    expect((await store.get(r.id)).state).toBe("signing");
    for (let n = 0; n < 5; n++) {
      const fail = tracked();
      await store.issue(fail);
      await store.claim(fail, 1n);
      await store.report(user, fail.id, "failed");
      await store.report(user, fail.id, "failed");
    }
    await expect(store.check(user)).rejects.toMatchObject({ reason: "quota" });
    const expired = tracked("expired");
    await store.issue(expired);
    await redis.del(`sponsor:issued:${expired.id}`);
    await expect(store.get(expired.id)).rejects.toMatchObject({ reason: "record_expired" });
    const quota = tracked("quota");
    await store.issue(quota);
    await redis.set(`sponsor:day:quota:${Math.floor(now / 86_400_000)}`, "200");
    await expect(store.claim(quota, 1n)).rejects.toMatchObject({ reason: "quota" });
    const circuit = tracked("circuit");
    await store.issue(circuit);
    await expect(store.claim(circuit, 100n)).rejects.toMatchObject({ reason: "kill_switch" });
    expect(await redis.get(SPONSOR_KILL_KEY)).toBe("daily_spend_cap");
    await expect(store.check("any")).rejects.toMatchObject({ reason: "kill_switch" });
  } finally {
    await redis.del(...keys, SPONSOR_KILL_KEY);
  }
});

it("rejects ineligible balance/notional, missing referral, mock prices and live kill switch", async () => {
  for (const mode of ["balance", "notional", "referral", "mock", "kill"] as const) {
    const s = await sponsorSetup();
    if (mode === "balance")
      new DataView(s.rpc.state.get(s.source)!.data.buffer).setBigUint64(64, 4_000_000n, true);
    if (mode === "notional") s.context.swap!.inAmount = "4000000";
    if (mode === "referral") s.context.swap!.referralAccount = undefined;
    if (mode === "mock") Object.assign(s.market, { name: "mock" });
    if (mode === "kill") s.store.killed = true;
    await expect(s.sponsor.register(s.encoded(), s.context)).rejects.toMatchObject({
      reason: mode === "kill" ? "kill_switch" : "quota",
    });
    expect(s.store.charges).toHaveLength(0);
  }
});
it("values USDC at face value without metadata and keeps SOL priced on the default live allowlist", async () => {
  const s = await sponsorSetup();
  const market = new LiveMarketDataProvider({
    allowlist: MockMarketDataProvider.mints,
    fetch: async (url) => Response.json(url.includes("search") ? tokenFixture : priceFixture),
  });
  expect(await market.getToken(MINTS.USDC)).toBeNull();
  expect((await market.getToken(MINTS.SOL))?.priceUsd).toBeGreaterThan(0);
  const getToken = mock(market.getToken.bind(market));
  market.getToken = getToken;
  const sponsor = new ValidatedFeeSponsor({ ...s.options, market });
  await expect(sponsor.register(s.encoded(), s.context)).resolves.toEqual({ expiresAt: 1_030_000 });
  expect(getToken.mock.calls).toEqual([[MINTS.SOL]]);
  s.context.swap!.inAmount = "4000000";
  await expect(sponsor.register(s.encoded(), s.context)).rejects.toMatchObject({ reason: "quota" });
});
it("still requires live SOL pricing for USDC swaps", async () => {
  const s = await sponsorSetup();
  s.market.getToken = async () => null;
  await expect(s.sponsor.register(s.encoded(), s.context)).rejects.toMatchObject({ reason: "quota" });
  expect(s.store.records.size).toBe(0);
});
it("never uses the fee payer as the referral account", async () => {
  const s = await sponsorSetup();
  s.context.swap!.referralAccount = s.payer;
  const sponsor = new ValidatedFeeSponsor({ ...s.options, referralAccount: s.payer });
  await expect(sponsor.register(s.encoded(), s.context)).rejects.toMatchObject({ reason: "fee_payer_role" });
  expect(s.store.charges).toHaveLength(0);
});
