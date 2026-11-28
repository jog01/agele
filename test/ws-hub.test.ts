import { describe, expect, it } from "bun:test";
import { WsHub } from "../src/ws/hub";
import { NotificationSocketSession } from "../src/ws/notification-session";
import { notificationTopic } from "../src/ws/topics";
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

  it("allows only the authenticated account's notification topic", async () => {
    const hub = new WsHub();
    const socket = fakeSocket();
    const userId = crypto.randomUUID();
    const own = notificationTopic(userId);
    const other = notificationTopic(crypto.randomUUID());
    const session = new NotificationSocketSession(
      async (token) => (token === "valid" ? { userId, expiresAt: Date.now() + 1000 } : undefined),
      () => {},
    );
    const authenticate = (token: string) => session.handle(JSON.stringify({ op: "authenticate", token }));
    const subscribe = (topic: string) =>
      hub.handle(JSON.stringify({ op: "subscribe", topic }), socket, session.authorizedTopic());
    try {
      expect(subscribe(own)).toEqual({ type: "error", message: "forbidden topic" });
      expect(await authenticate("invalid")).toEqual({ type: "error", message: "authentication failed" });
      expect(await authenticate("valid")).toEqual({ type: "authenticated" });
      expect(subscribe(other)).toEqual({ type: "error", message: "forbidden topic" });
      expect(subscribe(own)).toEqual({ type: "subscribed", topic: own });
      expect(socket.subs).toEqual(new Set([own]));
      expect(await authenticate("valid")).toMatchObject({ type: "error" });
    } finally {
      session.close();
    }
  });

  it("closes the authenticated socket when its access token expires", async () => {
    const closed = Promise.withResolvers<void>();
    const session = new NotificationSocketSession(
      async () => ({ userId: crypto.randomUUID(), expiresAt: Date.now() + 25 }),
      closed.resolve,
    );
    try {
      expect(await session.handle('{"op":"authenticate","token":"valid"}')).toEqual({
        type: "authenticated",
      });
      await closed.promise;
      expect(session.authorizedTopic()).toBeUndefined();
    } finally {
      session.close();
    }
  });
});
