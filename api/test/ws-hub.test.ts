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
});
