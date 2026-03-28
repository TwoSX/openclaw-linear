import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const socketInstances: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  readonly sent: string[] = [];
  readonly ping = vi.fn();
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  });
  readyState = MockWebSocket.CONNECTING;

  constructor(readonly url: string) {
    socketInstances.push(this);
  }

  on(event: string, handler: (...args: any[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(event: string, ...args: any[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

vi.mock("ws", () => ({
  default: MockWebSocket,
}));

const {
  LinearGatewaySocket,
  buildGatewayWebSocketUrl,
  resolveRuntimePluginConfig,
} = await import("./index.js");

describe("LinearGatewaySocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socketInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the gateway websocket URL with auth and routing params", () => {
    const url = new URL(
      buildGatewayWebSocketUrl(
        resolveRuntimePluginConfig({
          gatewayBaseUrl: "https://worker.example.com",
          clientAuthToken: "client-token",
        }),
      ),
    );

    expect(url.toString()).toContain("wss://worker.example.com/ws?");
    expect(url.searchParams.get("clientAuthToken")).toBe("client-token");
    expect(url.searchParams.get("instanceId")).toMatch(/^openclaw-/);
  });

  it("sends the ready control message and protocol ping frames after connect", async () => {
    const socket = new LinearGatewaySocket({
      gatewayBaseUrl: "https://worker.example.com",
      clientAuthToken: "client-token",
    });

    socket.connect();

    const client = socketInstances[0];
    expect(client).toBeDefined();

    client!.readyState = MockWebSocket.OPEN;
    client!.emit("open");

    expect(client!.sent).toHaveLength(1);
    const control = JSON.parse(client!.sent[0] ?? "{}");
    expect(control).toMatchObject({
      type: "control",
      payload: {
        action: "ready",
      },
    });
    expect(control.payload.instanceId).toMatch(/^openclaw-/);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(client!.ping).toHaveBeenCalledTimes(1);
  });
});
