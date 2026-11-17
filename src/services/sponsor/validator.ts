import { createHash } from "node:crypto";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  type Transaction,
} from "@solana/kit";
import { type SponsorRegisterContext, SponsorRejectedError, type SponsorRejectReason } from "./fee-sponsor";
import { PROGRAMS } from "./programs";
import type { SponsorAccount, SponsorRpc } from "./sponsor-rpc";
import { isSwapMintAllowed, SWAP_MINTS_V01 } from "./swap-mints";

export function refuse(reason: SponsorRejectReason): never {
  throw new SponsorRejectedError(reason);
}
export const u64 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
export const pubkey = (bytes: Uint8Array, offset: number) =>
  getAddressDecoder().decode(bytes.subarray(offset, offset + 32));
export function tokenAccount(account: SponsorAccount | null | undefined) {
  if (
    !account ||
    (account.owner !== PROGRAMS.token && account.owner !== PROGRAMS.token2022) ||
    account.data.length < 165
  )
    return null;
  return { mint: pubkey(account.data, 0), owner: pubkey(account.data, 32), amount: u64(account.data, 64) };
}
export function decodeTransaction(encoded: string): Transaction {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return refuse("malformed");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 1232 || bytes.length === 0) return refuse("malformed");
    const transaction = getTransactionDecoder().decode(bytes);
    if (!Buffer.from(getTransactionEncoder().encode(transaction)).equals(bytes)) return refuse("malformed");
    return transaction;
  } catch {
    return refuse("malformed");
  }
}

export interface SponsorValidation {
  transaction: Transaction;
  addresses: string[];
  payerFundedAtas: string[];
  expectedFeeLamports: bigint;
  expectedRentLamports: bigint;
  lastValidBlockHeight: number;
}

export class SponsorValidator {
  private readonly mintCache = new Map<string, { expiresAt: number; account: SponsorAccount }>();
  constructor(
    private readonly rpc: SponsorRpc,
    private readonly payer: string,
    private readonly caps = { maxCuPrice: 2_000_000n, maxLamports: 10_000_000n },
    private readonly now: () => number = Date.now,
  ) {}

  private async mint(mint: string) {
    if (!isSwapMintAllowed(mint)) refuse("mint_not_allowed");
    let cached = this.mintCache.get(mint);
    if (!cached || cached.expiresAt <= this.now()) {
      const [account] = await this.rpc.accounts([mint]);
      if (
        !account ||
        account.data.length < 82 ||
        (account.owner !== PROGRAMS.token && account.owner !== PROGRAMS.token2022)
      )
        return refuse("token_extension");
      cached = { account, expiresAt: this.now() + 10_000 };
      this.mintCache.set(mint, cached);
    }
    const account = cached.account;
    if (
      (new DataView(account.data.buffer, account.data.byteOffset).getUint32(0, true) !== 0 &&
        pubkey(account.data, 4) === this.payer) ||
      (new DataView(account.data.buffer, account.data.byteOffset).getUint32(46, true) !== 0 &&
        pubkey(account.data, 50) === this.payer)
    )
      return refuse("fee_payer_role");
    if (account.owner === PROGRAMS.token2022 && account.data.length > 82) {
      if (account.data.length < 166 || account.data[165] !== 1) refuse("token_extension");
      for (let offset = 166; offset < account.data.length; ) {
        if (offset + 4 > account.data.length) refuse("token_extension");
        const view = new DataView(account.data.buffer, account.data.byteOffset + offset);
        const type = view.getUint16(0, true),
          length = view.getUint16(2, true);
        if (type === 0 && length === 0) break;
        if (offset + 4 + length > account.data.length) refuse("token_extension");
        // Only metadata-related extensions have no transfer/authority behavior.
        if (![18, 19, 20, 21, 22, 23].includes(type)) refuse("token_extension");
        offset += 4 + length;
      }
    }
  }

  async validate(encoded: string, context: SponsorRegisterContext): Promise<SponsorValidation> {
    if (context.kind !== "swap") return refuse("instruction_not_allowed");
    const expected = context.swap;
    if (!expected || !/^[1-9]\d*$/.test(expected.inAmount) || !/^\d+$/.test(expected.otherAmountThreshold))
      return refuse("malformed");
    await this.mint(expected.inputMint);
    await this.mint(expected.outputMint);
    const transaction = decodeTransaction(encoded);
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (message.version !== 0 && message.version !== "legacy") return refuse("malformed");
    const accounts: string[] = [...message.staticAccounts];
    if (
      message.header.numSignerAccounts > accounts.length ||
      message.header.numReadonlySignerAccounts >= message.header.numSignerAccounts ||
      message.header.numReadonlyNonSignerAccounts > accounts.length - message.header.numSignerAccounts
    )
      return refuse("malformed");
    if (accounts[0] !== this.payer || !Object.hasOwn(transaction.signatures, this.payer))
      return refuse("fee_payer_role");
    if (!Object.hasOwn(transaction.signatures, context.wallet) || context.wallet === this.payer)
      return refuse("signature_cap");
    // JupiterZ account-role schemas need a separate reviewed decoder; do not infer them from a router label.
    if (expected.router === "jupiterz") return refuse("instruction_not_allowed");
    if (message.header.numSignerAccounts > 2) return refuse("signature_cap");
    const writable: string[] = [],
      readonly: string[] = [];
    if (message.version === 0) {
      try {
        for (const lookup of message.addressTableLookups ?? []) {
          const [table] = await this.rpc.accounts([lookup.lookupTableAddress], "confirmed");
          if (
            !table ||
            table.owner !== PROGRAMS.lookup ||
            table.executable ||
            table.data.length < 56 ||
            (table.data.length - 56) % 32 !== 0 ||
            new DataView(table.data.buffer, table.data.byteOffset).getUint32(0, true) !== 1 ||
            u64(table.data, 4) !== 18446744073709551615n
          )
            return refuse("lookup_table");
          for (const [indexes, target] of [
            [lookup.writableIndexes, writable],
            [lookup.readonlyIndexes, readonly],
          ] as const) {
            for (const index of indexes) {
              if (56 + (index + 1) * 32 > table.data.length) return refuse("lookup_table");
              const key = pubkey(table.data, 56 + index * 32);
              if (key === this.payer) return refuse("fee_payer_role");
              target.push(key);
            }
          }
        }
      } catch (error) {
        if (error instanceof SponsorRejectedError && error.reason === "fee_payer_role") throw error;
        return refuse("lookup_table");
      }
    }
    accounts.push(...writable, ...readonly);
    if (accounts.length > 100 || new Set(accounts).size !== accounts.length) return refuse("malformed");
    const pre = await this.rpc.accounts(accounts);
    for (let i = 0; i < accounts.length; i++) {
      const token = tokenAccount(pre[i]!);
      if (token?.owner === this.payer) return refuse("fee_payer_role");
      if (token) await this.mint(token.mint);
    }
    const rent = await this.rpc.rent(165);
    let rentPaid = 0n,
      cuLimit = 0n,
      cuPrice = 0n,
      limits = 0,
      prices = 0,
      atas = 0,
      routes = 0;
    const temporary = new Map<string, string>();
    const initialized = new Set<string>();
    const payerFundedAtas = new Set<string>();
    for (const ix of message.instructions) {
      const program = accounts[ix.programAddressIndex];
      const keys = (ix.accountIndices ?? []).map((index) => accounts[index]);
      if (!program || keys.some((key) => !key)) return refuse("malformed");
      if (
        !Object.values<string>(PROGRAMS)
          .filter((p) => p !== PROGRAMS.lookup)
          .includes(program)
      )
        return refuse("program_not_allowed");
      const data = new Uint8Array(ix.data ?? []);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const payerSlots = keys.flatMap((key, index) => (key === this.payer ? [index] : []));
      if (
        program === PROGRAMS.system &&
        data.length >= 4 &&
        [4, 5, 6, 7, 12].includes(view.getUint32(0, true))
      )
        return refuse("nonce");
      if (
        payerSlots.some(
          (slot) =>
            !(
              ((program === PROGRAMS.ata || program === PROGRAMS.system) && slot === 0) ||
              ([PROGRAMS.token, PROGRAMS.token2022].includes(program as typeof PROGRAMS.token) &&
                data[0] === 9 &&
                slot === 1)
            ),
        )
      )
        return refuse("fee_payer_role");
      if (program === PROGRAMS.compute) {
        if (keys.length) return refuse("instruction_not_allowed");
        if (data[0] === 2 && data.length === 5) {
          limits++;
          cuLimit = BigInt(view.getUint32(1, true));
        } else if (data[0] === 3 && data.length === 9) {
          prices++;
          cuPrice = u64(data, 1);
        } else return refuse("instruction_not_allowed");
      } else if (program === PROGRAMS.system) {
        if (data.length < 4) return refuse("malformed");
        const kind = view.getUint32(0, true);
        if ([4, 5, 6, 7, 12].includes(kind)) return refuse("nonce");
        if (kind === 0 && data.length === 52 && keys.length === 2) {
          if (
            ![this.payer, context.wallet].includes(keys[0]!) ||
            u64(data, 12) !== 165n ||
            pubkey(data, 20) !== PROGRAMS.token ||
            u64(data, 4) > rent ||
            pre[accounts.indexOf(keys[1]!)] !== null
          )
            return refuse("instruction_not_allowed");
          temporary.set(keys[1]!, keys[0]!);
          if (keys[0] === this.payer) rentPaid += u64(data, 4);
        } else if (kind === 2 && data.length === 12 && keys.length === 2) {
          if (keys[0] !== context.wallet || !temporary.has(keys[1]!))
            return refuse("instruction_not_allowed");
        } else return refuse("instruction_not_allowed");
      } else if (program === PROGRAMS.ata) {
        if (
          !(data.length === 0 || (data.length === 1 && [0, 1].includes(data[0]!))) ||
          keys.length < 6 ||
          keys[0] !== this.payer ||
          keys[2] !== context.wallet ||
          keys[4] !== PROGRAMS.system ||
          ![PROGRAMS.token, PROGRAMS.token2022].includes(keys[5] as typeof PROGRAMS.token)
        )
          return refuse("instruction_not_allowed");
        await this.mint(keys[3]!);
        const [ata] = await getProgramDerivedAddress({
          programAddress: address(PROGRAMS.ata),
          seeds: [
            getAddressEncoder().encode(address(context.wallet)),
            getAddressEncoder().encode(address(keys[5]!)),
            getAddressEncoder().encode(address(keys[3]!)),
          ],
        });
        if (keys[1] !== ata) return refuse("instruction_not_allowed");
        if (++atas > 2) return refuse("instruction_not_allowed");
        if (pre[accounts.indexOf(keys[1]!)] === null) {
          payerFundedAtas.add(keys[1]!);
          rentPaid += keys[5] === PROGRAMS.token2022 ? await this.rpc.rent(170) : rent;
        }
      } else if (program === PROGRAMS.token || program === PROGRAMS.token2022) {
        const kind = data[0];
        if (
          (kind === 3 && data.length === 9 && keys.length === 3) ||
          (kind === 12 && data.length === 10 && keys.length === 4)
        ) {
          if (keys[kind === 3 ? 2 : 3] !== context.wallet) return refuse("instruction_not_allowed");
        } else if (kind === 9 && data.length === 1 && keys.length === 3) {
          const funder = temporary.get(keys[0]!);
          if (
            !funder ||
            !initialized.has(keys[0]!) ||
            keys[2] !== context.wallet ||
            keys[1] !== (funder === this.payer ? this.payer : context.wallet)
          )
            return refuse("instruction_not_allowed");
        } else if (kind === 17 && data.length === 1 && keys.length === 1) {
          if (!temporary.has(keys[0]!)) return refuse("instruction_not_allowed");
        } else if (kind === 18 && data.length === 33 && keys.length === 2) {
          if (
            !temporary.has(keys[0]!) ||
            keys[1] !== SWAP_MINTS_V01.SOL ||
            pubkey(data, 1) !== context.wallet
          )
            return refuse("instruction_not_allowed");
          initialized.add(keys[0]!);
        } else return refuse("instruction_not_allowed");
      } else if (program === PROGRAMS.jupiter) {
        const discriminator = Buffer.from(data.subarray(0, 8));
        const route = discriminator.equals(
          createHash("sha256").update("global:route").digest().subarray(0, 8),
        );
        const shared = discriminator.equals(
          createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8),
        );
        if ((!route && !shared) || keys[route ? 1 : 2] !== context.wallet || keys[0] !== PROGRAMS.token)
          return refuse("instruction_not_allowed");
        const source = keys[route ? 2 : 3]!,
          destination = keys[route ? 3 : 6]!;
        const inputToken = tokenAccount(pre[accounts.indexOf(source)]);
        if (
          !(inputToken?.owner === context.wallet && inputToken.mint === expected.inputMint) &&
          !(initialized.has(source) && expected.inputMint === SWAP_MINTS_V01.SOL)
        )
          return refuse("instruction_not_allowed");
        const outputToken = tokenAccount(pre[accounts.indexOf(destination)]);
        if (outputToken && (outputToken.owner !== context.wallet || outputToken.mint !== expected.outputMint))
          return refuse("instruction_not_allowed");
        routes++;
      } else if (program === PROGRAMS.memo && (keys.length || data.length > 128))
        return refuse("instruction_not_allowed");
    }
    if (
      limits !== 1 ||
      prices > 1 ||
      cuLimit === 0n ||
      cuLimit > 1_400_000n ||
      cuPrice > this.caps.maxCuPrice
    )
      return refuse("fee_cap");
    if (routes !== 1 || temporary.size !== initialized.size) return refuse("instruction_not_allowed");
    const expectedFeeLamports =
      BigInt(message.header.numSignerAccounts) * 5000n + (cuLimit * cuPrice + 999_999n) / 1_000_000n;
    if (expectedFeeLamports + rentPaid > this.caps.maxLamports) return refuse("fee_cap");
    if (!(await this.rpc.validBlockhash(message.lifetimeToken))) return refuse("blockhash");
    const height = await this.rpc.blockHeight();
    const lastValidBlockHeight = expected.lastValidBlockHeight
      ? Number(expected.lastValidBlockHeight)
      : height;
    if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= height)
      return refuse("blockhash");
    address(context.wallet);
    return {
      transaction,
      addresses: accounts,
      payerFundedAtas: [...payerFundedAtas],
      expectedFeeLamports,
      expectedRentLamports: rentPaid,
      lastValidBlockHeight,
    };
  }
}
