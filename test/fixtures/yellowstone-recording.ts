import { getBase58Encoder } from "@solana/kit";
import { SubscribeUpdateTransactionInfo } from "@triton-one/yellowstone-grpc";

type RpcInstruction = {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
};
type RpcBalance = { accountIndex: number; mint: string; uiTokenAmount: { decimals: number; amount: string } };

export type Recording = {
  transactionIndex: number;
  rpc: {
    slot: number;
    blockTime: number | null;
    transaction: {
      signatures: string[];
      message: { accountKeys: string[]; instructions: RpcInstruction[] };
    };
    meta: {
      err: unknown;
      loadedAddresses?: { writable: string[]; readonly: string[] };
      innerInstructions: { index: number; instructions: RpcInstruction[] }[];
      preTokenBalances: RpcBalance[];
      postTokenBalances: RpcBalance[];
    };
  };
};

const encoder = getBase58Encoder();
const bytes = (value: string) => new Uint8Array(encoder.encode(value));

const instruction = (ix: RpcInstruction) => ({
  programIdIndex: ix.programIdIndex,
  accounts: Uint8Array.from(ix.accounts),
  data: bytes(ix.data),
});

export function recordedTransaction(recording: Recording): SubscribeUpdateTransactionInfo {
  const { transaction, meta } = recording.rpc;
  return SubscribeUpdateTransactionInfo.fromPartial({
    index: recording.transactionIndex.toString(),
    signature: bytes(transaction.signatures[0]!),
    transaction: {
      signatures: transaction.signatures.map(bytes),
      message: {
        accountKeys: transaction.message.accountKeys.map(bytes),
        instructions: transaction.message.instructions.map(instruction),
      },
    },
    meta: {
      err: meta.err ? { err: Uint8Array.of(1) } : undefined,
      loadedWritableAddresses: meta.loadedAddresses?.writable.map(bytes),
      loadedReadonlyAddresses: meta.loadedAddresses?.readonly.map(bytes),
      innerInstructions: meta.innerInstructions.map((group) => ({
        index: group.index,
        instructions: group.instructions.map((ix) => ({
          ...instruction(ix),
          stackHeight: ix.stackHeight ?? undefined,
        })),
      })),
      preTokenBalances: meta.preTokenBalances,
      postTokenBalances: meta.postTokenBalances,
    },
  });
}
