import { createHash } from "node:crypto";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase58Decoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  type Instruction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from "@solana/kit";
import type { MarketDataProvider } from "../src/services/market-data";
import type { SponsorRegisterContext } from "../src/services/sponsor/fee-sponsor";
import { MemorySponsorStore } from "../src/services/sponsor/issued-store";
import { PROGRAMS } from "../src/services/sponsor/programs";
import type { SponsorAccount, SponsorRpc } from "../src/services/sponsor/sponsor-rpc";
import { SWAP_MINTS_V01 as MINTS } from "../src/services/sponsor/swap-mints";
import { ValidatedFeeSponsor } from "../src/services/sponsor/validated-fee-sponsor";
import { SponsorValidator } from "../src/services/sponsor/validator";

export const meta = (key: string, role = AccountRole.READONLY) => ({ address: address(key), role });
export const ix = (
  program: string,
  keys: ReturnType<typeof meta>[],
  data: Uint8Array = new Uint8Array(),
): Instruction => ({ programAddress: address(program), accounts: keys, data });
export const encode = (transaction: Transaction) =>
  Buffer.from(getTransactionEncoder().encode(transaction)).toString("base64");
export function numeric(tag: number, value: bigint, size = 9) {
  const data = new Uint8Array(size);
  data[0] = tag;
  if (size === 5) new DataView(data.buffer).setUint32(1, Number(value), true);
  else new DataView(data.buffer).setBigUint64(1, value, true);
  return data;
}
export function token(mint: string, owner: string, amount: bigint, program = PROGRAMS.token): SponsorAccount {
  const data = new Uint8Array(165);
  data.set(getAddressEncoder().encode(address(mint)), 0);
  data.set(getAddressEncoder().encode(address(owner)), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return { owner: program, lamports: 2_039_280n, data, executable: false };
}
export const systemAccount = (): SponsorAccount => ({
  owner: PROGRAMS.system,
  lamports: 2_000_000_000n,
  data: new Uint8Array(),
  executable: false,
});
export class FakeSponsorRpc implements SponsorRpc {
  readonly state = new Map<string, SponsorAccount>();
  height = 100;
  valid = true;
  simulations = 0;
  error: unknown = null;
  mutate: (accounts: (SponsorAccount | null)[], addresses: string[]) => void = () => {};
  async accounts(addresses: string[]) {
    return addresses.map((a) => structuredClone(this.state.get(a) ?? null));
  }
  async validBlockhash() {
    return this.valid;
  }
  async blockHeight() {
    return this.height;
  }
  async rent() {
    return 2_039_280n;
  }
  async simulate(_transaction: string, addresses: string[]) {
    this.simulations++;
    const accounts = await this.accounts(addresses);
    this.mutate(accounts, addresses);
    return { err: this.error, accounts };
  }
  async tokenAccounts(owner: string) {
    return [...this.state.entries()]
      .filter(
        ([, a]) =>
          a.data.length === 165 &&
          Buffer.from(a.data.subarray(32, 64)).equals(
            Buffer.from(getAddressEncoder().encode(address(owner))),
          ),
      )
      .map(([address, account]) => ({ address, account: structuredClone(account) }));
  }
}
export async function sponsorSetup() {
  const payerKey = await generateKeyPair(true),
    userKey = await generateKeyPair(true),
    extraKey = await generateKeyPair();
  const payer = await getAddressFromPublicKey(payerKey.publicKey),
    wallet = await getAddressFromPublicKey(userKey.publicKey),
    extra = await getAddressFromPublicKey(extraKey.publicKey);
  const ata = async (mint: string) =>
    (
      await getProgramDerivedAddress({
        programAddress: address(PROGRAMS.ata),
        seeds: [
          getAddressEncoder().encode(wallet),
          getAddressEncoder().encode(address(PROGRAMS.token)),
          getAddressEncoder().encode(address(mint)),
        ],
      })
    )[0];
  const source = await ata(MINTS.USDC),
    destination = await ata(MINTS.JUP);
  const rpc = new FakeSponsorRpc();
  rpc.state.set(payer, systemAccount());
  rpc.state.set(wallet, systemAccount());
  for (const mint of Object.values(MINTS)) {
    const data = new Uint8Array(82);
    data[44] = 6;
    data[45] = 1;
    rpc.state.set(mint, { owner: PROGRAMS.token, lamports: 1_461_600n, data, executable: false });
  }
  rpc.state.set(source, token(MINTS.USDC, wallet, 20_000_000n));
  rpc.state.set(destination, token(MINTS.JUP, wallet, 0n));
  rpc.mutate = (accounts, addresses) => {
    accounts[addresses.indexOf(payer)]!.lamports -= 10_100n;
    new DataView(accounts[addresses.indexOf(source)]!.data.buffer).setBigUint64(64, 10_000_000n, true);
    new DataView(accounts[addresses.indexOf(destination)]!.data.buffer).setBigUint64(64, 10_000_000n, true);
  };
  let now = 1_000_000;
  const store = new MemorySponsorStore(() => now);
  const context: SponsorRegisterContext = {
    userId: "user",
    wallet,
    kind: "swap",
    requestId: crypto.randomUUID(),
    swap: {
      inputMint: MINTS.USDC,
      outputMint: MINTS.JUP,
      inAmount: "10000000",
      otherAmountThreshold: "9000000",
      router: "metis",
      lastValidBlockHeight: "200",
      feeBps: 50,
      referralAccount: extra,
    },
  };
  const market: MarketDataProvider = {
    name: "live",
    listTrending: async () => [],
    getCandles: async () => [],
    getHistoricalPriceUsd: async () => null,
    getRecentTrades: async () => [],
    getHolders: async (mint) => ({ mint, totalHolders: 0, top10Pct: 0, holders: [], updatedAt: 0 }),
    getToken: async (mint) => ({
      mint,
      symbol: "TOKEN",
      name: "Token",
      decimals: 6,
      imageUrl: null,
      priceUsd: mint === MINTS.SOL ? 150 : 1,
      priceChange24hPct: 0,
      marketCapUsd: 0,
      liquidityUsd: 0,
      volume24hUsd: 0,
      holders: 0,
    }),
  };
  const secretBytes = new Uint8Array(64);
  secretBytes.set(new Uint8Array(await crypto.subtle.exportKey("pkcs8", payerKey.privateKey)).subarray(-32));
  secretBytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", payerKey.publicKey)), 32);
  const options = {
    enabled: () => true,
    feePayer: payer,
    secret: getBase58Decoder().decode(secretBytes),
    rpc,
    store,
    market,
    referralAccount: extra,
    referralFeeBps: 50,
    now: () => now,
  };
  const sponsor = new ValidatedFeeSponsor({ ...options });
  const compute = [
    ix(PROGRAMS.compute, [], numeric(2, 100_000n, 5)),
    ix(PROGRAMS.compute, [], numeric(3, 1000n)),
  ];
  const routeData = new Uint8Array(35);
  routeData.set(createHash("sha256").update("global:route").digest().subarray(0, 8));
  const routeView = new DataView(routeData.buffer);
  routeView.setUint32(8, 1, true);
  routeData.set([7, 100, 0, 1], 12);
  routeView.setBigUint64(16, 10_000_000n, true);
  routeView.setBigUint64(24, 10_000_000n, true);
  routeView.setUint16(32, 50, true);
  routeData[34] = 50;
  const route = ix(
    PROGRAMS.jupiter,
    [
      meta(PROGRAMS.token),
      meta(wallet, AccountRole.READONLY_SIGNER),
      meta(source, AccountRole.WRITABLE),
      meta(destination, AccountRole.WRITABLE),
      meta(PROGRAMS.jupiter),
      meta(MINTS.JUP),
      meta(PROGRAMS.jupiter),
      meta(extra),
      meta(PROGRAMS.jupiter),
    ],
    routeData,
  );
  const message = (instructions: Instruction[] = [...compute, route]) =>
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash(MINTS.SOL), lastValidBlockHeight: 200n },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
  const transaction = (instructions?: Instruction[]) => compileTransaction(message(instructions));
  const encoded = (instructions?: Instruction[]) => encode(transaction(instructions));
  const signUser = async (transactionToSign = transaction()) =>
    encode(await partiallySignTransaction([userKey], transactionToSign));
  return {
    payer,
    wallet,
    extra,
    source,
    destination,
    payerKey,
    userKey,
    secretBytes,
    rpc,
    store,
    context,
    market,
    options,
    sponsor,
    compute,
    route,
    message,
    transaction,
    encoded,
    signUser,
    setNow: (value: number) => {
      now = value;
    },
    validator: new SponsorValidator(rpc, payer),
  };
}
