import { AppError } from "./errors";

export async function withRedisDeadline<T>(command: () => Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(command),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis deadline exceeded")), timeoutMs);
      }),
    ]);
  } catch {
    throw new AppError(503, "rate_limit_unavailable", "Swap rate-limit storage temporarily unavailable");
  } finally {
    clearTimeout(timer);
  }
}
