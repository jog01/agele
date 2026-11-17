import { createMiddleware } from "hono/factory";
import type { Container } from "../container";
import type { AppEnv } from "../types";

export const withContainer = (container: Container) =>
  createMiddleware<AppEnv>(async (c, next) => {
    c.set("container", container);
    await next();
  });
