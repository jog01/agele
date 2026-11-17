import { z } from "zod";
import { SponsorRejectedError } from "./fee-sponsor";

export interface SponsorAccount {
  owner: string;
  lamports: bigint;
  data: Uint8Array;
  executable: boolean;
}
export interface SponsorRpc {
  accounts(addresses: string[], commitment?: "confirmed" | "processed"): Promise<(SponsorAccount | null)[]>;
  validBlockhash(blockhash: string): Promise<boolean>;
  blockHeight(): Promise<number>;
  rent(size: number): Promise<bigint>;
  simulate(
    transaction: string,
    addresses: string[],
  ): Promise<{ err: unknown; accounts: (SponsorAccount | null)[] }>;
  tokenAccounts(owner: string): Promise<{ address: string; account: SponsorAccount }[]>;
}

const AccountSchema = z.object({
  owner: z.string(),
  lamports: z.number().int().nonnegative().safe(),
  executable: z.boolean(),
  data: z.tuple([z.string(), z.literal("base64")]),
});
const parseAccount = (input: unknown): SponsorAccount | null => {
  if (input === null) return null;
  const a = AccountSchema.parse(input);
  return { ...a, lamports: BigInt(a.lamports), data: new Uint8Array(Buffer.from(a.data[0], "base64")) };
};

export class HttpSponsorRpc implements SponsorRpc {
  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call(method: string, params: unknown[]): Promise<unknown> {
    try {
      const res = await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error();
      const body = z.object({ result: z.unknown(), error: z.unknown().optional() }).parse(await res.json());
      if (body.error || body.result === undefined) throw new Error();
      return body.result;
    } catch {
      throw new SponsorRejectedError("simulation");
    }
  }

  async accounts(addresses: string[], commitment: "confirmed" | "processed" = "confirmed") {
    if (!addresses.length) return [];
    const result = z
      .object({ value: z.array(z.unknown()) })
      .parse(await this.call("getMultipleAccounts", [addresses, { encoding: "base64", commitment }]));
    if (result.value.length !== addresses.length) throw new SponsorRejectedError("simulation");
    return result.value.map(parseAccount);
  }
  async validBlockhash(blockhash: string) {
    return z
      .object({ value: z.boolean() })
      .parse(await this.call("isBlockhashValid", [blockhash, { commitment: "confirmed" }])).value;
  }
  async blockHeight() {
    return z
      .number()
      .int()
      .nonnegative()
      .parse(await this.call("getBlockHeight", [{ commitment: "confirmed" }]));
  }
  async rent(size: number) {
    return BigInt(
      z
        .number()
        .int()
        .nonnegative()
        .safe()
        .parse(await this.call("getMinimumBalanceForRentExemption", [size])),
    );
  }
  async simulate(transaction: string, addresses: string[]) {
    const result = z
      .object({ value: z.object({ err: z.unknown(), accounts: z.array(z.unknown()).nullable() }) })
      .parse(
        await this.call("simulateTransaction", [
          transaction,
          {
            encoding: "base64",
            sigVerify: false,
            replaceRecentBlockhash: false,
            commitment: "processed",
            accounts: { encoding: "base64", addresses },
          },
        ]),
      );
    if (!result.value.accounts || result.value.accounts.length !== addresses.length)
      throw new SponsorRejectedError("simulation");
    return { err: result.value.err, accounts: result.value.accounts.map(parseAccount) };
  }
  async tokenAccounts(owner: string) {
    const results = await Promise.all(
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].map(
        async (programId) => {
          const result = z
            .object({ value: z.array(z.object({ pubkey: z.string(), account: z.unknown() })) })
            .parse(
              await this.call("getTokenAccountsByOwner", [
                owner,
                { programId },
                { encoding: "base64", commitment: "confirmed" },
              ]),
            );
          return result.value.map((a) => ({ address: a.pubkey, account: parseAccount(a.account)! }));
        },
      ),
    );
    return results.flat();
  }
}
