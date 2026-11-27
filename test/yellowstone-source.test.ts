import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import { createServer, type ServerHttp2Stream } from "node:http2";
import { CommitmentLevel, SubscribeRequest, SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import type { ChainEvent, ChainEventSource } from "../src/services/chain-ingest/events";
import { PROGRAMS } from "../src/services/chain-ingest/programs";
import { createMarketChainSource } from "../src/services/chain-ingest/source";
import { grpcConnection, YellowstoneSource } from "../src/services/chain-ingest/yellowstone";
import pump from "./fixtures/yellowstone/pump-trade.json";
import cpmm from "./fixtures/yellowstone/raydium-cpmm.json";
import { recordedTransaction } from "./fixtures/yellowstone-recording";

function block(slot: number, parent: number) {
  const update = SubscribeUpdate.fromPartial({
    filters: ["dex"],
    block: {
      slot: slot.toString(),
      parentSlot: parent.toString(),
      transactions: [recordedTransaction(pump), recordedTransaction(cpmm)],
    },
  });
  const body = SubscribeUpdate.encode(update).finish();
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

describe("Yellowstone source", () => {
  it("only replaces the demo source when the endpoint and token are both set", () => {
    const demo: ChainEventSource = { async run() {} };
    const endpoint = "https://example.com:443";
    expect(createMarketChainSource(demo, {})).toBe(demo);
    expect(createMarketChainSource(demo, { YELLOWSTONE_GRPC_URL: endpoint })).toBe(demo);
    expect(createMarketChainSource(demo, { YELLOWSTONE_GRPC_TOKEN: "test-key" })).toBe(demo);
    expect(
      createMarketChainSource(demo, {
        YELLOWSTONE_GRPC_URL: endpoint,
        YELLOWSTONE_GRPC_TOKEN: "test-key",
      }),
    ).toBeInstanceOf(YellowstoneSource);
  });

  it("uses the SDK over gRPC and resumes after both a replay gap and a failed sink write", async () => {
    const requests: {
      path: string | undefined;
      token: string | string[] | undefined;
      request: SubscribeRequest;
    }[] = [];
    const server = createServer();
    server.on("stream", (stream, headers) => {
      stream.on("error", () => {});
      (stream as ServerHttp2Stream).respond({ ":status": 200, "content-type": "application/grpc" });
      let data = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.length < 5 || data.length < data.readUInt32BE(1) + 5) return;
        const request = SubscribeRequest.decode(data.subarray(5, data.readUInt32BE(1) + 5));
        requests.push({ path: headers[":path"], token: headers["x-token"], request });
        if (requests.length === 1) stream.write(block(102, 101));
        else stream.write(Buffer.concat([block(99, 98), block(100, 97)]));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No test gRPC server address");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const checkpoints: number[] = [];
    const received: (readonly ChainEvent[])[] = [];
    const source = new YellowstoneSource(
      grpcConnection(`http://127.0.0.1:${addr.port}`, "test-key"),
      {
        async load() {
          return 100;
        },
        async advance(slot) {
          checkpoints.push(slot);
          controller.abort();
        },
      },
      {
        async load() {
          return new Map();
        },
        async remember() {},
      },
    );
    try {
      await source.run(
        {
          async ingest(events) {
            received.push(events);
            if (received.length === 1) throw new Error("test database disconnect");
          },
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
      server.close();
    }
    expect(requests).toHaveLength(3);
    for (const { token, request, path } of requests) {
      expect(path).toBe("/geyser.Geyser/Subscribe");
      expect(token).toBe("test-key");
      expect(request.fromSlot).toBe("100");
      expect(request.commitment).toBe(CommitmentLevel.FINALIZED);
      expect(request.blocks.dex?.accountInclude).toEqual(Object.values(PROGRAMS));
    }
    expect(checkpoints).toEqual([101]);
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(received[1]);
    expect(received[1]).toMatchObject([
      { kind: "Trade", slot: 100, market: { venue: "raydium-cpmm" }, blockTime: null },
      { kind: "Trade", slot: 100, market: { venue: "pump.fun" }, blockTime: null },
    ]);
  });
});
