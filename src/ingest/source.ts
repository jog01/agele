import type { ChainEvent } from "./events";

/** Events within a batch are in slot order. */
export interface IngestBatch {
  source: "simulator" | "grpc";
  events: ChainEvent[];
}

/** Sinks must be idempotent on (signature, ixIndex). */
export interface IngestSink {
  ingest(batch: IngestBatch): Promise<void>;
}

/** Both the simulator and a Yellowstone gRPC indexer implement this interface. */
export interface ChainSource {
  readonly name: string;
  /** Starts ingestion and returns an async stop function. */
  start(sink: IngestSink): Promise<() => Promise<void>>;
}
