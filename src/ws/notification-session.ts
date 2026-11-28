import { AuthenticateFrame, notificationTopic, type ServerMessage } from "./topics";

export class NotificationSocketSession {
  private authorization?: { topic: string; expiresAt: number };
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private authenticating = false;

  constructor(
    private readonly authenticate: (
      token: string,
    ) => Promise<{ userId: string; expiresAt: number } | undefined>,
    private readonly closeSocket: () => void,
  ) {}

  authorizedTopic() {
    return this.authorization && this.authorization.expiresAt > Date.now()
      ? this.authorization.topic
      : undefined;
  }

  async handle(raw: string): Promise<ServerMessage | undefined> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const auth = AuthenticateFrame.safeParse(frame);
    if (!auth.success) return;
    if (this.closed || this.authenticating || this.authorization)
      return { type: "error", message: "already authenticating or authenticated" };

    this.authenticating = true;
    try {
      const session = await this.authenticate(auth.data.token);
      if (this.closed || !session || session.expiresAt <= Date.now())
        return { type: "error", message: "authentication failed" };
      this.authorization = { topic: notificationTopic(session.userId), expiresAt: session.expiresAt };
      this.timer = setTimeout(this.closeSocket, Math.min(session.expiresAt - Date.now(), 2 ** 31 - 1));
      return { type: "authenticated" };
    } catch {
      return { type: "error", message: "authentication failed" };
    } finally {
      this.authenticating = false;
    }
  }

  close() {
    this.closed = true;
    this.authorization = undefined;
    clearTimeout(this.timer);
  }
}
