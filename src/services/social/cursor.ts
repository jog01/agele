import { badRequest } from "../../lib/errors";

export type FeedCursor = { createdAt: number; id: string };

export function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString("base64url");
}

export function decodeCursor(value: string): FeedCursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      !cursor ||
      !Number.isSafeInteger(cursor.createdAt) ||
      cursor.createdAt < 0 ||
      typeof cursor.id !== "string" ||
      !cursor.id ||
      encodeCursor(cursor) !== value
    )
      throw new Error();
    return cursor;
  } catch {
    throw badRequest("Invalid feed cursor");
  }
}
