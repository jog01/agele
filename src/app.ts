import { httpInstrumentationMiddleware } from "@hono/otel";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { env } from "./config/env";
import type { Container } from "./container";
import { v1 } from "./controllers";
import { healthController } from "./controllers/health.controller";
import { withContainer } from "./middlewares/container";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler";
import { requestLogger } from "./middlewares/request-logger";
import { PriceTickSchema } from "./schemas/token";
import type { AppEnv } from "./types";

export function createApp(container: Container) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          { error: { code: "validation_error", message: "Invalid request", details: result.error.issues } },
          400,
        );
      }
    },
  });

  app.use(httpInstrumentationMiddleware({ serviceName: env.OTEL_SERVICE_NAME }));
  app.use(requestId());
  app.use(secureHeaders());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true, exposeHeaders: ["X-Data-Source"] }));
  app.use(requestLogger);
  app.use(withContainer(container));

  app.route("/", healthController);
  app.route("/v1", v1);
  app.openAPIRegistry.register("PriceTick", PriceTickSchema);

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Privy access token",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "fomo API",
      version: "0.1.0",
      description:
        'WebSocket /ws: subscribe with {"op":"subscribe","topic":"token:<mint>:price"}. Events contain {type:"event",topic,data:PriceTick}; time is Unix seconds. Live price ticks poll every 5 seconds only for subscribed allowlisted mints. token:<mint>:trades is synthetic in mock mode only; live trades are available via REST with a Birdeye key.',
    },
  });
  app.get("/docs", Scalar({ url: "/openapi.json" }));

  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
