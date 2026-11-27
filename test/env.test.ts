import { expect, it } from "bun:test";

it("requires an explicit live market provider for a configured Helius webhook", () => {
  const command = [
    process.execPath,
    "-e",
    'import {env} from "./src/config/env"; console.log(env.MARKET_DATA_PROVIDER)',
  ];
  const env = { PATH: process.env.PATH, HELIUS_WEBHOOK_SECRET: "fixture" };
  const missing = Bun.spawnSync(command, { env });
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("Helius indexing requires MARKET_DATA_PROVIDER=live");
  const demo = Bun.spawnSync(command, { env: { PATH: env.PATH } });
  expect(demo.stdout.toString().trim()).toBe("indexed");
  const live = Bun.spawnSync(command, { env: { ...env, MARKET_DATA_PROVIDER: "live" } });
  expect(live.stdout.toString().trim()).toBe("live");
});
