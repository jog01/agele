export const RAYDIUM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

export const largest = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    context: { slot: 123 },
    value: Array.from({ length: 20 }, (_, i) => ({
      address: `token-account-${i}`,
      amount: String((20 - i) * 100),
      decimals: 2,
      uiAmount: 20 - i,
      uiAmountString: String(20 - i),
    })),
  },
};

export const owners = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    context: { slot: 123 },
    value: largest.result.value.map((_, i) => ({
      executable: false,
      lamports: 2039280,
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: {
        program: "spl-token",
        parsed: {
          type: "account",
          info: {
            owner: i < 2 ? "merged-wallet" : i === 2 ? RAYDIUM_AUTHORITY : `wallet-${i}`,
          },
        },
      },
    })),
  },
};

export const supply = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    context: { slot: 123 },
    value: { amount: "100000", decimals: 2, uiAmount: 1000, uiAmountString: "1000" },
  },
};

export const nativeSupply = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    context: { slot: 123 },
    value: {
      total: 600_000_000_000_000_000,
      circulating: 590_000_000_000_000_000,
      nonCirculating: 10_000_000_000_000_000,
      nonCirculatingAccounts: [],
    },
  },
};

export const wrappedSolLargest = {
  ...largest,
  result: {
    ...largest.result,
    value: largest.result.value.map((account, i) => ({
      ...account,
      amount: String(BigInt(20 - i) * 1_000_000_000_000_000n),
      decimals: 9,
      uiAmount: (20 - i) * 1_000_000,
      uiAmountString: String((20 - i) * 1_000_000),
    })),
  },
};
