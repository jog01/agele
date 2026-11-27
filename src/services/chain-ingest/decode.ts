import type { Amount, ChainEvent, EventRef, Market } from "./events";
import {
  calls,
  discriminator,
  PROGRAMS,
  QUOTES,
  SOL,
  SYSTEM,
  swapLayout,
  TOKEN_PROGRAMS,
  tag,
} from "./programs";
import { address, type Instruction, type Transaction, walk } from "./transaction";

type Fill = Extract<ChainEvent, { kind: "Trade" }>;
type Leg = { from: number; to: number; amount: Amount };
export type DecodedEvent = { event: ChainEvent; realTokenReserves?: bigint };
const pumpCreates = calls("create", "create_v2");
const pumpMigrates = calls("migrate", "migrate_v2");
const pumpLegacySwaps = calls("buy", "sell", "buy_exact_sol_in");
const pumpSwapsV2 = calls("buy_v2", "sell_v2", "buy_exact_quote_in_v2");
const pumpSwapsV3 = calls("buy_v3", "sell_v3", "buy_exact_quote_in_v3");
const pumpSwapBuys = calls("buy", "buy_exact_quote_in", "buy_v2", "buy_exact_quote_in_v2");
const pumpSwapSells = calls("sell", "sell_v2");
const createPool = discriminator("global", "create_pool");
const emitCpi = "e445a52e51cb9a1d";
const createEvent = discriminator("event", "CreateEvent");
const tradeEvent = discriminator("event", "TradeEvent");

function key(tx: Transaction, ix: Instruction, index: number) {
  return tx.keys[ix.accounts[index] ?? -1];
}

function ref(tx: Transaction, ix: Instruction, mint: string): EventRef {
  return {
    source: "solana",
    signature: tx.signature,
    slot: tx.slot,
    transactionIndex: tx.transactionIndex,
    eventIndex: ix.index,
    blockTime: tx.blockTime,
    mint,
  };
}

function leg(tx: Transaction, ix: Instruction): Leg | undefined {
  if (!TOKEN_PROGRAMS.has(ix.programId)) return;
  const { data } = ix;
  const checkedWithFee = data[0] === 26 && data[1] === 1 && data.length === 19;
  const checked = data[0] === 12 && data.length === 10;
  const unchecked = data[0] === 3 && data.length === 9;
  if (!(checkedWithFee || checked || unchecked)) return;
  const from = ix.accounts[0];
  const to = ix.accounts[unchecked ? 1 : 2];
  if (from === undefined || to === undefined || from === to) return;
  const offset = checkedWithFee ? 2 : 1;
  const balance = tx.tokens.get(from) ?? tx.tokens.get(to);
  const mint = unchecked ? balance?.mint : key(tx, ix, 1);
  const decimals = unchecked ? balance?.decimals : data[offset + 8];
  if (!mint || decimals === undefined) return;
  const raw = data.readBigUInt64LE(offset);
  if (raw === 0n) return;
  return { from, to, amount: { mint, decimals, raw: raw.toString() } };
}

function swapLegs(
  tx: Transaction,
  ix: Instruction,
  input: number | undefined,
  output: number | undefined,
  vaults: readonly [number | undefined, number | undefined],
  fee?: number,
): [Amount, Amount] | undefined {
  if (input === undefined || output === undefined || vaults.some((vault) => vault === undefined)) return;
  const inputs: Amount[] = [];
  const outputs: Amount[] = [];
  const fees: Amount[] = [];
  // DAMM v1 settles via nested vault calls; other layouts settle directly.
  const transfers = fee === undefined ? ix.children : walk(ix.children);
  for (const child of transfers) {
    const transfer = leg(tx, child);
    if (!transfer) continue;
    const { from, to, amount } = transfer;
    if (from === input && vaults.includes(to)) inputs.push(amount);
    else if (to === output && vaults.includes(from)) outputs.push(amount);
    else if (from === input && to === fee) fees.push(amount);
  }
  const [spent] = inputs;
  const [received] = outputs;
  if (!spent || !received || inputs.length !== 1 || outputs.length !== 1 || spent.mint === received.mint)
    return;
  if (fees.some((f) => f.mint !== spent.mint || f.decimals !== spent.decimals)) return;
  const raw = fees.reduce((total, f) => total + BigInt(f.raw), BigInt(spent.raw)).toString();
  return [{ ...spent, raw }, received];
}

function fill(
  tx: Transaction,
  ix: Instruction,
  market: Market,
  trader: string,
  side: Fill["side"],
  base: Amount,
  quote: Amount,
): Fill {
  return { ...ref(tx, ix, base.mint), kind: "Trade", market, trader, side, base, quote };
}

function swap(tx: Transaction, ix: Instruction): Fill | undefined {
  if (ix.programId === PROGRAMS.pumpSwap) {
    const id = tag(ix.data);
    const isBuy = pumpSwapBuys.has(id);
    if (!isBuy && !pumpSwapSells.has(id)) return;
    const pool = key(tx, ix, 0);
    const trader = key(tx, ix, 1);
    if (!pool || !trader) return;
    const a = ix.accounts;
    const legs = swapLegs(tx, ix, a[isBuy ? 6 : 5], a[isBuy ? 5 : 6], [a[7], a[8]]);
    if (!legs) return;
    const [base, quote] = isBuy ? [legs[1], legs[0]] : legs;
    if (base.mint !== key(tx, ix, 3) || quote.mint !== key(tx, ix, 4)) return;
    return fill(
      tx,
      ix,
      { address: pool, venue: "pumpswap", programId: ix.programId },
      trader,
      isBuy ? "buy" : "sell",
      base,
      quote,
    );
  }
  const layout = swapLayout(ix.programId, ix.data, ix.accounts.length);
  if (!layout) return;
  const pool = key(tx, ix, layout.pool);
  const trader = key(tx, ix, layout.trader);
  if (!pool || !trader) return;
  const a = ix.accounts;
  const legs = swapLegs(
    tx,
    ix,
    a[layout.input],
    a[layout.output],
    [a[layout.vaults[0]], a[layout.vaults[1]]],
    layout.inputFee !== undefined ? a[layout.inputFee] : undefined,
  );
  if (!legs) return;
  const [spent, received] = legs;
  const quoteRank = (mint: string) => (QUOTES.includes(mint) ? QUOTES.indexOf(mint) : QUOTES.length);
  const spentRank = quoteRank(spent.mint);
  const receivedRank = quoteRank(received.mint);
  const buy = spentRank === receivedRank ? spent.mint < received.mint : spentRank < receivedRank;
  return fill(
    tx,
    ix,
    { address: pool, venue: layout.venue, programId: ix.programId },
    trader,
    buy ? "buy" : "sell",
    buy ? received : spent,
    buy ? spent : received,
  );
}

function launchStrings(data: Buffer, offset: number): { offset: number; uri: string } | undefined {
  let uri = "";
  for (let field = 0; field < 3; field++) {
    if (offset + 4 > data.length) return;
    const size = data.readUInt32LE(offset);
    offset += 4;
    if (offset + size > data.length) return;
    if (field === 2) uri = data.toString("utf8", offset, offset + size);
    offset += size;
  }
  return { offset, uri };
}

function pumpEvent(ix: Instruction, event: string): Buffer | undefined {
  return ix.children.find(
    (c) =>
      c.programId === PROGRAMS.pump && tag(c.data) === emitCpi && c.data.toString("hex", 8, 16) === event,
  )?.data;
}

function launchReserves(ix: Instruction, mint: string, curve: string): bigint | undefined {
  const data = pumpEvent(ix, createEvent);
  if (!data) return;
  const fields = launchStrings(data, 16);
  if (!fields) return;
  const { offset } = fields;
  // Four pubkeys, then timestamp, virtual token reserves, virtual quote reserves, real token reserves.
  const realReservesOffset = offset + 32 * 4 + 8 * 3;
  if (
    data.length < realReservesOffset + 8 ||
    address(data.subarray(offset, offset + 32)) !== mint ||
    address(data.subarray(offset + 32, offset + 64)) !== curve
  )
    return;
  return data.readBigUInt64LE(realReservesOffset);
}

function pumpTrade(tx: Transaction, ix: Instruction, id: string): DecodedEvent | undefined {
  const legacy = pumpLegacySwaps.has(id);
  const v2 = pumpSwapsV2.has(id);
  if (!legacy && !v2 && !pumpSwapsV3.has(id)) return;
  const mint = key(tx, ix, legacy ? 2 : 1);
  const curve = key(tx, ix, legacy ? 3 : v2 ? 10 : 5);
  const trader = key(tx, ix, legacy ? 6 : v2 ? 13 : 8);
  const quoteMint = legacy ? SOL : key(tx, ix, 2);
  const baseAccount = ix.accounts[legacy ? 4 : v2 ? 11 : 6];
  if (!mint || !curve || !trader || !quoteMint || baseAccount === undefined) return;

  const data = pumpEvent(ix, tradeEvent);
  if (
    !data ||
    data.length < 97 ||
    address(data.subarray(16, 48)) !== mint ||
    address(data.subarray(65, 97)) !== trader ||
    (data[64] !== 0 && data[64] !== 1)
  )
    return;

  const isBuy = data[64] === 1;
  const baseRaw = data.readBigUInt64LE(56);
  const baseDecimals =
    tx.tokens.get(baseAccount)?.decimals ??
    ix.children.map((c) => leg(tx, c)).find((l) => l?.amount.mint === mint)?.amount.decimals;
  if (!baseRaw || baseDecimals === undefined) return;
  const base = { mint, raw: baseRaw.toString(), decimals: baseDecimals };
  let quote: Amount;
  if (quoteMint === SOL || quoteMint === SYSTEM) {
    const raw = data.readBigUInt64LE(48);
    if (!raw) return;
    quote = { mint: SOL, raw: raw.toString(), decimals: 9 };
  } else {
    // The original event's SOL field may be zero for non-SOL curves.
    const vault = ix.accounts[v2 ? 12 : 7];
    const user = ix.accounts[v2 ? 15 : 10];
    const match = ix.children
      .map((c) => leg(tx, c))
      .find(
        (l) =>
          l &&
          l.amount.mint === quoteMint &&
          l.from === (isBuy ? user : vault) &&
          l.to === (isBuy ? vault : user),
      );
    if (!match) return;
    quote = match.amount;
  }
  const event = fill(
    tx,
    ix,
    { address: curve, venue: "pump.fun", programId: ix.programId },
    trader,
    isBuy ? "buy" : "sell",
    base,
    quote,
  );
  return { event, realTokenReserves: data.length >= 137 ? data.readBigUInt64LE(129) : undefined };
}

function pump(tx: Transaction, ix: Instruction): DecodedEvent | undefined {
  const id = tag(ix.data);
  if (pumpCreates.has(id)) {
    const mint = key(tx, ix, 0);
    const curve = key(tx, ix, 2);
    const details = launchStrings(ix.data, 8);
    if (!mint || !curve || !details || details.offset + 32 > ix.data.length) return;
    const init = [...walk(ix.children)].find(
      (c) =>
        TOKEN_PROGRAMS.has(c.programId) && key(tx, c, 0) === mint && (c.data[0] === 0 || c.data[0] === 20),
    );
    const decimals = init?.data[1];
    if (decimals === undefined) return;
    const event: ChainEvent = {
      ...ref(tx, ix, mint),
      kind: "TokenLaunched",
      market: { address: curve, venue: "pump.fun", programId: ix.programId },
      creator: address(ix.data.subarray(details.offset, details.offset + 32)),
      decimals,
      metadataUri: details.uri || undefined,
    };
    return { event, realTokenReserves: launchReserves(ix, mint, curve) };
  }
  if (pumpMigrates.has(id)) {
    const v2 = id !== discriminator("global", "migrate");
    const mint = key(tx, ix, 2);
    const curve = key(tx, ix, v2 ? 4 : 3);
    const pool = key(tx, ix, v2 ? 10 : 9);
    // migrate is idempotent: a successful instruction alone does not prove a migration.
    const created = ix.children.some(
      (c) =>
        c.programId === PROGRAMS.pumpSwap &&
        tag(c.data) === createPool &&
        key(tx, c, 0) === pool &&
        key(tx, c, 3) === mint,
    );
    if (!mint || !curve || !pool || !created) return;
    return {
      event: {
        ...ref(tx, ix, mint),
        kind: "Migrated",
        from: { address: curve, venue: "pump.fun", programId: ix.programId },
        to: { address: pool, venue: "pumpswap", programId: PROGRAMS.pumpSwap },
      },
    };
  }
  return pumpTrade(tx, ix, id);
}

export function decodeTransaction(tx: Transaction): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  for (const ix of walk(tx.instructions)) {
    if (ix.programId === PROGRAMS.pump) {
      const decoded = pump(tx, ix);
      if (decoded) events.push(decoded);
    } else {
      const event = swap(tx, ix);
      if (event) events.push({ event });
    }
  }
  return events;
}
