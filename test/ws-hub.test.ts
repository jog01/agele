import { describe, expect, it } from "bun:test";
import { WsHub } from "../src/ws/hub";
import { SOL } from "./helpers";

function fakeSocket() {
  const subs = new Set<string>();
  return {
    subs,
    subscribe: (t: string) => subs.add(t),
    unsubscribe: (t: string) => subs.delete(t),
    isSubscribed: (t: string) => subs.has(t),
  };
}

describe("WsHub", () => {
  it("subscribes to valid topics and tracks activity", () => {
    const hub = new WsHub();
    const s = fakeSocket();
    const topic = `token:${SOL}:trades`;
    expect(hub.handle(JSON.stringify({ op: "subscribe", topic }), s)).toEqual({ type: "subscribed", topic });
    expect(hub.activeTopics()).toEqual([topic]);
    hub.handle(JSON.stringify({ op: "unsubscribe", topic }), s);
    expect(hub.activeTopics()).toEqual([]);
  });

  it("rejects unknown topics and bad json", () => {
    const hub = new WsHub();
    expect(hub.handle(JSON.stringify({ op: "subscribe", topic: "admin:all" }), fakeSocket()).type).toBe(
      "error",
    );
    expect(hub.handle("{", fakeSocket()).type).toBe("error");
  });

  it("keeps activity until the last client disconnects", () => {
    const hub = new WsHub();
    const topic = `token:${SOL}:price`;
    const frame = JSON.stringify({ op: "subscribe", topic });
    const a = fakeSocket();
    hub.handle(frame, a);
    hub.handle(frame, a);
    hub.handle(frame, fakeSocket());
    hub.release([topic]);
    expect(hub.activeTopics()).toEqual([topic]);
    hub.release([topic]);
    expect(hub.activeTopics()).toEqual([]);
    hub.publish(topic, {});
  });
});
