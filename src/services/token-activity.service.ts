import { z } from "zod";
import { badRequest, notFound } from "../lib/errors";
import type { Position } from "../models";
import type { PgTokenActivityRepository, TokenTraderCursor } from "../repositories/token-activity.repository";
import type { MarketDataProvider } from "./market-data";
import { cachePositionQuotes, optionalQuote, type PositionQuote } from "./market-data/position-quotes";

const cursorSchema = z.object({
  mint: z.string(),
  volumeUsd: z
    .string()
    .max(80)
    .regex(/^\d+(?:\.\d+)?$/),
  userId: z.uuid(),
});

function decodeCursor(encoded: string, mint: string): TokenTraderCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid encoding");
    const buffer = Buffer.from(encoded, "base64url");
    if (buffer.toString("base64url") !== encoded) throw new Error("Invalid encoding");
    const cursor = cursorSchema.parse(JSON.parse(buffer.toString()));
    if (cursor.mint !== mint) throw new Error("Wrong token");
    return cursor;
  } catch {
    throw badRequest("Invalid token traders cursor");
  }
}

function valuePosition(position: Position, price: number | undefined) {
  const quantity = Number(position.quantity);
  const cost = Number(position.costBasisUsd);
  const avgCostUsd = quantity > 0 ? cost / quantity : 0;
  const hasPrice = price !== undefined && Number.isFinite(price) && price > 0;
  const priceUsd = hasPrice ? price : avgCostUsd;
  const valueUsd = hasPrice ? quantity * priceUsd : cost;
  return { quantity, avgCostUsd, priceUsd, valueUsd, unrealizedPnlUsd: valueUsd - cost };
}

export class TokenActivityService {
  constructor(
    private readonly repository: PgTokenActivityRepository,
    private readonly market: MarketDataProvider,
    private readonly positionQuote: PositionQuote = (mint) => market.getToken(mint),
  ) {}

  async getPosition(userId: string, mint: string) {
    const [stored, row] = await Promise.all([
      this.repository.getToken(mint),
      this.repository.getPosition(userId, mint),
    ]);
    const token = row
      ? await optionalQuote(() => this.positionQuote(mint, row.seeded))
      : !stored
        ? await this.market.getToken(mint)
        : null;
    if (!stored && !token) throw notFound("Token");
    return {
      position: row
        ? {
            mint,
            symbol: token?.symbol ?? stored!.symbol,
            ...valuePosition(row.position, token?.priceUsd),
            realizedPnlUsd: Number(row.position.realizedPnlUsd),
          }
        : null,
    };
  }

  async getTraders(mint: string, limit: number, encodedCursor?: string) {
    const cursor = encodedCursor === undefined ? undefined : decodeCursor(encodedCursor, mint);
    const [stored, rows] = await Promise.all([
      this.repository.getToken(mint),
      this.repository.getTraders(mint, limit + 1, cursor),
    ]);
    const quote = cachePositionQuotes(this.positionQuote);
    if (!stored && !(await this.market.getToken(mint))) throw notFound("Token");
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      traders: await Promise.all(
        page.map(async (row) => {
          const realizedPnlUsd = Number(row.realizedPnlUsd);
          const token =
            row.position && Number(row.position.quantity) > 0 ? await quote(mint, row.seeded) : null;
          const unrealizedPnlUsd = row.position
            ? valuePosition(row.position, token?.priceUsd).unrealizedPnlUsd
            : 0;
          return {
            wallet: row.wallet,
            handle: row.handle ?? (row.wallet ?? row.userId).slice(0, 8),
            buys: row.buys,
            sells: row.sells,
            volumeUsd: Number(row.volumeUsd),
            realizedPnlUsd,
            unrealizedPnlUsd,
            pnlUsd: realizedPnlUsd + unrealizedPnlUsd,
          };
        }),
      ),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ mint, volumeUsd: last.volumeUsd, userId: last.userId })).toString(
              "base64url",
            )
          : null,
    };
  }
}
