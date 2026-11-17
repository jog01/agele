import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const unauthorized = (message = "Unauthorized") => new AppError(401, "unauthorized", message);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, details);
