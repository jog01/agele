import pino from "pino";
import { env } from "../config/env";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  base: { service: env.OTEL_SERVICE_NAME },
  redact: ["req.headers.authorization", "*.privateKey", "*.secret"],
});

export type Logger = typeof logger;
