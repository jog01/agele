import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../types";
import { meController } from "./me.controller";
import { socialController } from "./social.controller";
import { swapsController } from "./swaps.controller";
import { tokensController } from "./tokens.controller";

export const v1 = new OpenAPIHono<AppEnv>()
  .route("/", tokensController)
  .route("/", meController)
  .route("/", swapsController)
  .route("/", socialController);
