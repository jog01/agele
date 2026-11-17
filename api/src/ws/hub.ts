import type { Server } from "bun";
import { ClientMessage, type ServerMessage } from "./topics";

/** Thin wrapper over Bun's native pub/sub; one process, fan-out via Redis later. */
export class WsHub {
  private server: Server<unknown> | undefined;
  private readonly counts = new Map<string, number>();

  attach(server: Server<unknown>) {
    this.server = server;
  }

  publish(topic: string, data: unknown) {
    if (!this.server) return;
    const msg: ServerMessage = { type: "event", topic, data };
    this.server.publish(topic, JSON.stringify(msg));
  }

  activeTopics() {
    return [...this.counts.entries()].filter(([, n]) => n > 0).map(([t]) => t);
  }

  /** Handles one raw client frame; returns the reply to send. */
  handle(
    raw: string,
    socket: { subscribe(t: string): void; unsubscribe(t: string): void; isSubscribed(t: string): boolean },
  ): ServerMessage {
    let parsed: ReturnType<typeof ClientMessage.safeParse>;
    try {
      parsed = ClientMessage.safeParse(JSON.parse(raw));
    } catch {
      return { type: "error", message: "invalid json" };
    }
    if (!parsed.success) return { type: "error", message: "invalid message" };
    const msg = parsed.data;
    switch (msg.op) {
      case "ping":
        return { type: "pong" };
      case "subscribe":
        if (!socket.isSubscribed(msg.topic)) {
          socket.subscribe(msg.topic);
          this.counts.set(msg.topic, (this.counts.get(msg.topic) ?? 0) + 1);
        }
        return { type: "subscribed", topic: msg.topic };
      case "unsubscribe":
        if (socket.isSubscribed(msg.topic)) {
          socket.unsubscribe(msg.topic);
          this.counts.set(msg.topic, Math.max(0, (this.counts.get(msg.topic) ?? 1) - 1));
        }
        return { type: "unsubscribed", topic: msg.topic };
    }
  }

  release(topics: Iterable<string>) {
    for (const t of topics) this.counts.set(t, Math.max(0, (this.counts.get(t) ?? 1) - 1));
  }
}
