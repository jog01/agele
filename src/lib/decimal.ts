const SCALE = 10n ** 18n;

export function decimal(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`Invalid decimal: ${value}`);
  return (
    (match[1] ? -1n : 1n) *
    (BigInt(match[2]!) * SCALE + BigInt((match[3] ?? "").padEnd(18, "0").slice(0, 18)))
  );
}

export function formatDecimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(18, "0")}`;
}

export const multiply = (a: bigint, b: bigint) => (a * b) / SCALE;
export const divide = (a: bigint, b: bigint) => (a * SCALE) / b;

export function rawDecimal(amount: string, decimals: number): bigint {
  return (BigInt(amount) * SCALE) / 10n ** BigInt(decimals);
}
