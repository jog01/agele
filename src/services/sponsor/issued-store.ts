import type Redis from "ioredis";
import { z } from "zod";
import type { SponsorRegisterContext } from "./fee-sponsor";
import { refuse } from "./validator";

export interface IssuedRecord {
  id: string;
  context: SponsorRegisterContext;
  messageHash: string;
  lastValidBlockHeight: number;
  expectedFeeLamports: string;
  expectedRentLamports: string;
  createdAt: number;
  expiresAt: number;
  state: "issued" | "signing";
  outcome?: string;
}
export interface SponsorStore {
  check(userId: string): Promise<void>;
  issue(record: IssuedRecord): Promise<void>;
  get(requestId: string): Promise<IssuedRecord>;
  claim(record: IssuedRecord, lamports: bigint): Promise<void>;
  report(userId: string, requestId: string, status: string): Promise<void>;
}

const recordSchema = z.object({
  id: z.string(),
  context: z.object({
    userId: z.string(),
    wallet: z.string(),
    kind: z.literal("swap"),
    requestId: z.string(),
    swap: z.object({
      inputMint: z.string(),
      outputMint: z.string(),
      inAmount: z.string(),
      otherAmountThreshold: z.string(),
      router: z.string(),
      lastValidBlockHeight: z.string().optional(),
      feeBps: z.number().optional(),
      referralAccount: z.string().optional(),
    }),
  }),
  messageHash: z.string(),
  lastValidBlockHeight: z.number(),
  expectedFeeLamports: z.string(),
  expectedRentLamports: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  state: z.enum(["issued", "signing"]),
  outcome: z.string().optional(),
});
export const SPONSOR_KILL_KEY = "sponsor:kill";

export class RedisSponsorStore implements SponsorStore {
  constructor(
    private readonly redis: Redis,
    private readonly dailyCap: bigint = 1_000_000_000n,
    private readonly now: () => number = Date.now,
  ) {}

  private async evaluate(script: string, keys: string[], args: (string | number)[] = []) {
    try {
      return await this.redis.eval(script, keys.length, ...keys, ...args);
    } catch {
      return refuse("quota");
    }
  }
  async check(userId: string) {
    const result = await this.evaluate(
      "if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end; if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end; return 0",
      [SPONSOR_KILL_KEY, `sponsor:suspended:${userId}`],
    );
    if (Number(result) === 1) refuse("kill_switch");
    if (Number(result) !== 0) refuse("quota");
  }
  async issue(record: IssuedRecord) {
    await this.check(record.context.userId);
    const now = this.now();
    const result = await this.evaluate(
      `
      redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
      if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return 2 end
      if redis.call('ZCARD', KEYS[2]) >= 3 then return 1 end
      redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
      redis.call('SET', KEYS[3], 'issued', 'EX', 86400)
      redis.call('ZADD', KEYS[2], ARGV[2], ARGV[5]); redis.call('EXPIRE', KEYS[2], 60)
      return 0`,
      [`sponsor:issued:${record.id}`, `sponsor:open:${record.context.userId}`, `sponsor:seen:${record.id}`],
      [now, record.expiresAt, JSON.stringify(record), Math.max(1, record.expiresAt - now), record.id],
    );
    if (Number(result) === 2) refuse("record_used");
    if (Number(result) !== 0) refuse("quota");
  }
  async get(requestId: string): Promise<IssuedRecord> {
    let value: string | null, seen: string | null;
    try {
      const values = await this.redis.mget(`sponsor:issued:${requestId}`, `sponsor:seen:${requestId}`);
      value = values[0] ?? null;
      seen = values[1] ?? null;
    } catch {
      return refuse("record_missing");
    }
    if (!value)
      return refuse(seen === "signing" ? "record_used" : seen ? "record_expired" : "record_missing");
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch {
      return refuse("record_missing");
    }
    const parsed = recordSchema.safeParse(json);
    if (!parsed.success || parsed.data.id !== requestId) return refuse("record_missing");
    return parsed.data;
  }
  async claim(record: IssuedRecord, lamports: bigint) {
    const now = this.now(),
      user = record.context.userId;
    const minute = Math.floor(now / 60_000),
      day = Math.floor(now / 86_400_000);
    const result = await this.evaluate(
      `
      if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
      if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
      local raw = redis.call('GET', KEYS[3]); if not raw then return 3 end
      local r = cjson.decode(raw)
      if r.context.userId ~= ARGV[1] or r.messageHash ~= ARGV[2] then return 3 end
      if r.state ~= 'issued' then return 4 end
      if r.expiresAt <= tonumber(ARGV[3]) then return 5 end
      if tonumber(redis.call('GET', KEYS[4]) or '0') >= 10 or tonumber(redis.call('GET', KEYS[5]) or '0') >= 200 or tonumber(redis.call('GET', KEYS[6]) or '0') + tonumber(ARGV[4]) > 50000000 then return 2 end
      if tonumber(redis.call('GET', KEYS[7]) or '0') + tonumber(ARGV[4]) > tonumber(ARGV[5]) then redis.call('SET', KEYS[1], 'daily_spend_cap'); return 1 end
      for i=4,7 do redis.call('INCRBY', KEYS[i], i < 6 and 1 or ARGV[4]); redis.call('EXPIRE', KEYS[i], i == 4 and 120 or 172800) end
      r.state = 'signing'; redis.call('SET', KEYS[3], cjson.encode(r), 'EX', 86400)
      redis.call('SET', KEYS[8], 'signing', 'EX', 86400)
      redis.call('ZREM', KEYS[9], r.id)
      return 0`,
      [
        SPONSOR_KILL_KEY,
        `sponsor:suspended:${user}`,
        `sponsor:issued:${record.id}`,
        `sponsor:minute:${user}:${minute}`,
        `sponsor:day:${user}:${day}`,
        `sponsor:lamports:${user}:${day}`,
        `sponsor:spend:${day}`,
        `sponsor:seen:${record.id}`,
        `sponsor:open:${user}`,
      ],
      [user, record.messageHash, now, lamports.toString(), this.dailyCap.toString()],
    );
    const reasons = [
      undefined,
      "kill_switch",
      "quota",
      "record_missing",
      "record_used",
      "record_expired",
    ] as const;
    if (Number(result) !== 0) refuse(reasons[Number(result)] ?? "quota");
  }
  async report(userId: string, requestId: string, status: string) {
    const now = this.now();
    await this.evaluate(
      `
      local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
      local r=cjson.decode(raw); if r.context.userId ~= ARGV[1] or r.outcome then return 0 end
      if ARGV[2] == 'submitted' then return 0 end
      r.outcome=ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(r),'EX',86400)
      if ARGV[2] == 'failed' then
        redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',tonumber(ARGV[3])-600000)
        redis.call('ZADD',KEYS[2],ARGV[3],ARGV[4]); redis.call('EXPIRE',KEYS[2],600)
        if redis.call('ZCARD',KEYS[2]) >= 5 then redis.call('SET',KEYS[3],'failures','EX',3600) end
      end
      return 0`,
      [`sponsor:issued:${requestId}`, `sponsor:failed:${userId}`, `sponsor:suspended:${userId}`],
      [userId, status, now, requestId],
    );
  }
}

export class MemorySponsorStore implements SponsorStore {
  readonly records = new Map<string, IssuedRecord>();
  readonly charges: { user: string; time: number; lamports: bigint }[] = [];
  readonly failures = new Map<string, number[]>();
  readonly suspended = new Map<string, number>();
  killed = false;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly dailyCap = 1_000_000_000n,
  ) {}
  async check(userId: string) {
    if (this.killed) refuse("kill_switch");
    if ((this.suspended.get(userId) ?? 0) > this.now()) refuse("quota");
  }
  async issue(record: IssuedRecord) {
    await this.check(record.context.userId);
    if (this.records.has(record.id)) refuse("record_used");
    if (
      [...this.records.values()].filter(
        (r) => r.context.userId === record.context.userId && r.state === "issued" && r.expiresAt > this.now(),
      ).length >= 3
    )
      refuse("quota");
    this.records.set(record.id, structuredClone(record));
  }
  async get(requestId: string) {
    const record = this.records.get(requestId);
    if (!record) return refuse("record_missing");
    return structuredClone(record);
  }
  async claim(record: IssuedRecord, lamports: bigint) {
    await this.check(record.context.userId);
    const stored = this.records.get(record.id);
    if (
      !stored ||
      stored.context.userId !== record.context.userId ||
      stored.messageHash !== record.messageHash
    )
      return refuse("record_missing");
    if (stored.state !== "issued") refuse("record_used");
    if (stored.expiresAt <= this.now()) refuse("record_expired");
    const day = Math.floor(this.now() / 86_400_000),
      minute = Math.floor(this.now() / 60_000);
    const daily = this.charges.filter((c) => Math.floor(c.time / 86_400_000) === day);
    const user = daily.filter((c) => c.user === record.context.userId);
    if (
      user.length >= 200 ||
      user.filter((c) => Math.floor(c.time / 60_000) === minute).length >= 10 ||
      user.reduce((s, c) => s + c.lamports, 0n) + lamports > 50_000_000n
    )
      refuse("quota");
    if (daily.reduce((s, c) => s + c.lamports, 0n) + lamports > this.dailyCap) {
      this.killed = true;
      refuse("kill_switch");
    }
    stored.state = "signing";
    this.charges.push({ user: record.context.userId, time: this.now(), lamports });
  }
  async report(userId: string, requestId: string, status: string) {
    const record = this.records.get(requestId);
    if (!record || record.context.userId !== userId || record.outcome || status === "submitted") return;
    record.outcome = status;
    if (status === "failed") {
      const failed = [
        ...(this.failures.get(userId) ?? []).filter((t) => t > this.now() - 600_000),
        this.now(),
      ];
      this.failures.set(userId, failed);
      if (failed.length >= 5) this.suspended.set(userId, this.now() + 3_600_000);
    }
  }
}
