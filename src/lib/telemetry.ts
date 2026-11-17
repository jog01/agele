import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { env } from "../config/env";
import { logger } from "./logger";

let provider: NodeTracerProvider | undefined;

/** Starts tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise spans are no-ops. */
export function initTelemetry(serviceName = env.OTEL_SERVICE_NAME) {
  if (provider || !env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` })),
    ],
  });
  provider.register();
  logger.info({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }, "telemetry enabled");
}

export async function shutdownTelemetry() {
  await provider?.shutdown();
}

export const tracer = trace.getTracer("fomo-api");
