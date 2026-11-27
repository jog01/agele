import type { DecodedEvent } from "./decode";

export interface CurveReserveStore {
  load(curves: string[]): Promise<ReadonlyMap<string, bigint>>;
  remember(starts: ReadonlyMap<string, bigint>): Promise<void>;
}

export async function curveProgress(decoded: readonly DecodedEvent[], store: CurveReserveStore) {
  const addresses = new Set<string>();
  const starts = new Map<string, bigint>();
  for (const { event, realTokenReserves } of decoded) {
    if (event.kind === "TokenLaunched" && realTokenReserves !== undefined && realTokenReserves > 0n) {
      starts.set(event.market.address, realTokenReserves);
    }
    if (event.kind === "Trade" && event.market.venue === "pump.fun" && realTokenReserves !== undefined) {
      addresses.add(event.market.address);
    }
  }
  const missing = [...addresses].filter((address) => !starts.has(address));
  const known = missing.length ? await store.load(missing) : undefined;
  if (starts.size) await store.remember(starts);
  return decoded.map(({ event, realTokenReserves }) => {
    if (event.kind !== "Trade" || realTokenReserves === undefined) return event;
    const initial = starts.get(event.market.address) ?? known?.get(event.market.address);
    if (!initial || initial <= 0n) return event;
    const sold = initial > realTokenReserves ? initial - realTokenReserves : 0n;
    return { ...event, curveProgressBps: Number((sold * 10_000n) / initial) };
  });
}
