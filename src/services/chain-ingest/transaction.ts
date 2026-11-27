import { getBase58Decoder } from "@solana/kit";
import type { SubscribeUpdateTransactionInfo } from "@triton-one/yellowstone-grpc";

const base58 = getBase58Decoder();
export const address = (value: Uint8Array) => base58.decode(value);

export type Instruction = {
  index: number;
  programId: string;
  accounts: ReadonlyArray<number>;
  data: Buffer;
  children: Instruction[];
};

export type Transaction = {
  keys: string[];
  signature: string;
  slot: number;
  transactionIndex: number;
  blockTime: number | null;
  instructions: Instruction[];
  tokens: Map<number, { mint: string; decimals: number }>;
};

export function nonnegativeInteger(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function normalizeTransaction(
  update: SubscribeUpdateTransactionInfo,
  slot: number,
  blockTime: number | null,
): Transaction | undefined {
  const message = update.transaction?.message;
  const meta = update.meta;
  const transactionIndex = nonnegativeInteger(update.index);
  if (
    !message ||
    !meta ||
    meta.err ||
    update.isVote ||
    update.signature.length !== 64 ||
    transactionIndex === undefined
  ) {
    return;
  }
  const keys = [...message.accountKeys, ...meta.loadedWritableAddresses, ...meta.loadedReadonlyAddresses].map(
    address,
  );
  const groups = new Map(meta.innerInstructions.map((group) => [group.index, group.instructions]));
  const tokens: Transaction["tokens"] = new Map();
  for (const balance of [...meta.preTokenBalances, ...meta.postTokenBalances]) {
    if (balance.uiTokenAmount)
      tokens.set(balance.accountIndex, { mint: balance.mint, decimals: balance.uiTokenAmount.decimals });
  }

  let ordinal = 0;
  const node = (ix: { programIdIndex: number; data: Uint8Array; accounts: Uint8Array }): Instruction => ({
    index: ordinal++,
    programId: keys[ix.programIdIndex] ?? "",
    accounts: [...ix.accounts],
    data: Buffer.from(ix.data),
    children: [],
  });
  const instructions = message.instructions.map((ix, i) => {
    const root = node(ix);
    const stack = [root];
    let complete = true;
    for (const inner of groups.get(i) ?? []) {
      const child = node(inner);
      const height = inner.stackHeight;
      if (!complete || height === undefined || height < 2 || height > stack.length + 1) {
        complete = false;
        continue;
      }
      stack.length = height - 1;
      stack[height - 2]!.children.push(child);
      stack.push(child);
    }
    if (!complete) root.children = [];
    return root;
  });
  return {
    keys,
    signature: address(update.signature),
    slot,
    transactionIndex,
    blockTime,
    instructions,
    tokens,
  };
}

export function* walk(instructions: readonly Instruction[]): Generator<Instruction> {
  for (const ix of instructions) {
    yield ix;
    yield* walk(ix.children);
  }
}
