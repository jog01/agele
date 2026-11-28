export type DemoTokenLabel = { name: string; symbol: string };

export const demoTokenImage = (mint: string) =>
  `https://api.dicebear.com/9.x/bottts-neutral/png?seed=${mint}`;

export function demoMetadataUri(label: DemoTokenLabel, image: string) {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ ...label, image }))}`;
}

export class DemoTokenLabels {
  private readonly names = new Set<string>();
  private readonly symbols = new Set<string>();

  constructor(labels: readonly DemoTokenLabel[] = []) {
    for (const { name, symbol } of labels) {
      this.names.add(name.toLowerCase());
      this.symbols.add(symbol.toLowerCase());
    }
  }

  claim(mint: string, { name, symbol }: DemoTokenLabel, renameName = true, renameSymbol = true) {
    const tag = mint.slice(0, 5).toUpperCase();
    return {
      name: renameName ? this.claimLabel(this.names, name, ` · ${tag}`) : name,
      symbol: renameSymbol ? this.claimLabel(this.symbols, symbol, `-${tag}`) : symbol,
    };
  }

  private claimLabel(used: Set<string>, base: string, suffix: string) {
    let candidate = base;
    for (let n = 1; used.has(candidate.toLowerCase()); n++) {
      candidate = `${base}${suffix}${n === 1 ? "" : `-${n}`}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }
}
