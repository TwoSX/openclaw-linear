import {
  DEFAULT_BUFFER_MAX_ITEMS,
  serializeEnvelope,
  type GatewayActivityResultEnvelope,
  type GatewayControlEnvelope,
  type GatewayWebhookEnvelope,
} from "../../../shared/protocol.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createAgentActivity = vi.fn();
const refreshAccessToken = vi.fn();
const shouldRefreshToken = vi.fn();

vi.mock("./linear-api.js", () => ({
  createAgentActivity,
  refreshAccessToken,
  shouldRefreshToken,
}));

vi.mock("cloudflare:workers", () => {
  class DurableObject<TEnv = unknown> {
    protected readonly ctx: unknown;
    protected readonly env: TEnv;

    constructor(ctx: unknown, env: TEnv) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  return { DurableObject };
});

const { LinearBridgeDurableObject } = await import("./bridge-do.js");

class TestSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  attachment: unknown = null;
  readyState = TestSocket.OPEN;
  failNextSend = false;

  send(data: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("socket send failed");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = TestSocket.CLOSED;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

class TestWebSocketPair {
  readonly 0: TestSocket;
  readonly 1: TestSocket;

  constructor() {
    this[0] = new TestSocket();
    this[1] = new TestSocket();
  }
}

interface TestStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface TestState {
  storage: TestStorage;
  sockets: TestSocket[];
  acceptWebSocket(socket: TestSocket): void;
  getWebSockets(): TestSocket[];
}

interface BridgeHarness {
  bridge: any;
  ctx: TestState;
}

function createStorage(map = new Map<string, unknown>()): TestStorage {
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      map.set(key, value);
    },
  };
}

function createBridge(): BridgeHarness {
  const sockets: TestSocket[] = [];
  const ctx: TestState = {
    storage: createStorage(),
    sockets,
    acceptWebSocket(socket) {
      sockets.push(socket);
    },
    getWebSockets() {
      return sockets.filter((socket) => socket.readyState === TestSocket.OPEN);
    },
  };
  const env = {
    CLIENT_AUTH_TOKEN: "client-token",
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
  };

  const bridge = new LinearBridgeDurableObject(
    {
      id: {
        toString: () => "bridge:test",
      },
      ...ctx,
    } as unknown as DurableObjectState,
    env as never,
  ) as any;

  return { bridge, ctx };
}

function createWebhookEnvelope(eventId: string, organizationId = "org-1"): GatewayWebhookEnvelope {
  return {
    type: "webhook_event",
    eventId,
    timestamp: "2026-03-27T10:00:00.000Z",
    payload: {
      organizationId,
      agentSessionId: "session-1",
      eventType: "session.updated",
      raw: {
        id: eventId,
      },
    },
  };
}

function createControlEnvelope(
  action: GatewayControlEnvelope["payload"]["action"],
  instanceId: string,
): GatewayControlEnvelope {
  return {
    type: "control",
    eventId: `ctrl:${action}:${instanceId}`,
    timestamp: "2026-03-27T10:00:00.000Z",
    payload: {
      action,
      instanceId,
    },
  };
}

function readSocketActions(socket: TestSocket): string[] {
  return socket.sent.map((raw) => {
    const parsed = JSON.parse(raw) as
      | GatewayControlEnvelope
      | GatewayWebhookEnvelope
      | GatewayActivityResultEnvelope;
    return parsed.type === "control" ? parsed.payload.action : parsed.type;
  });
}

async function connectClient(
  harness: BridgeHarness,
  instanceId: string,
): Promise<TestSocket> {
  try {
    await harness.bridge.fetch(
      new Request(`https://worker.example/ws?instanceId=${instanceId}&clientAuthToken=client-token`, {
        headers: { upgrade: "websocket" },
      }),
    );
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
  }

  const client = harness.ctx.sockets.at(-1);
  if (!client) {
    throw new Error("Expected a websocket to be accepted.");
  }

  return client;
}

describe("LinearBridgeDurableObject", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-27T10:00:00.000Z"));
    vi.stubGlobal("WebSocketPair", TestWebSocketPair as unknown as typeof WebSocketPair);
    createAgentActivity.mockReset();
    refreshAccessToken.mockReset();
    shouldRefreshToken.mockReset();
    shouldRefreshToken.mockReturnValue(false);
  });

  it("rejects websocket upgrades before OAuth is configured", async () => {
    const { bridge } = createBridge();

    const response = await bridge.fetch(
      new Request("https://worker.example/ws?instanceId=inst-1&clientAuthToken=client-token", {
        headers: {
          upgrade: "websocket",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Complete OAuth first");
  });

  it("buffers matching webhooks until the client reports ready", async () => {
    const { bridge, ctx } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });

    const accepted = await connectClient({ bridge, ctx }, "inst-1");
    expect(accepted).toBeDefined();

    const first = await bridge.acceptWebhookEvent(createWebhookEnvelope("evt-1"));
    expect(first).toMatchObject({
      buffered: true,
      delivered: false,
      clientConnected: true,
      clientReady: false,
    });

    await bridge.handleControlMessage(
      accepted as unknown as WebSocket,
      createControlEnvelope("ready", "inst-1"),
    );

    expect(readSocketActions(accepted)).toEqual(["connected", "webhook_event"]);
  });

  it("resolves the active MCP proxy token without refreshing when still valid", async () => {
    const { bridge } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });

    shouldRefreshToken.mockReturnValueOnce(false);

    await expect(bridge.resolveMcpProxyAccessToken()).resolves.toEqual({
      accessToken: "access-token",
      organizationId: "org-1",
      organizationName: "Acme",
    });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes the active MCP proxy token before returning it when near expiry", async () => {
    const { bridge } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "stale-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T10:05:00.000Z",
    });

    shouldRefreshToken.mockReturnValueOnce(true);
    refreshAccessToken.mockResolvedValueOnce({
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: "2026-03-27T13:00:00.000Z",
    });

    await expect(bridge.resolveMcpProxyAccessToken()).resolves.toEqual({
      accessToken: "fresh-access-token",
      organizationId: "org-1",
      organizationName: "Acme",
    });
    expect(refreshAccessToken).toHaveBeenCalledWith({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
  });

  it("ignores webhooks for a non-active organization", async () => {
    const { bridge } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-active",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });

    const result = await bridge.acceptWebhookEvent(createWebhookEnvelope("evt-1", "org-other"));
    expect(result).toMatchObject({
      ignored: true,
      delivered: false,
      buffered: false,
    });
  });

  it("replaces the older client when a newer client connects", async () => {
    const { bridge, ctx } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });

    const oldClient = await connectClient({ bridge, ctx }, "old");
    const newClient = await connectClient({ bridge, ctx }, "new");

    expect(oldClient.closed).toEqual([
      { code: 4001, reason: "superseded by newer client" },
    ]);
    expect(newClient.closed).toEqual([]);
  });

  it("re-buffers direct webhook delivery when the active client send fails", async () => {
    const { bridge, ctx } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });

    const client = await connectClient({ bridge, ctx }, "inst-1");
    await bridge.handleControlMessage(
      client as unknown as WebSocket,
      createControlEnvelope("ready", "inst-1"),
    );
    client.failNextSend = true;

    const result = await bridge.acceptWebhookEvent(createWebhookEnvelope("evt-send-fail"));

    expect(result).toMatchObject({
      buffered: true,
      delivered: false,
    });

    const snapshot = await bridge.statusSnapshot();
    expect(snapshot.bufferDepth).toBe(1);
  });

  it("disconnects the current client when OAuth switches workspace", async () => {
    const { bridge, ctx } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });

    const client = await connectClient({ bridge, ctx }, "inst-1");

    await bridge.storeOAuthState({
      viewerId: "viewer-2",
      viewerName: "Bob",
      viewerEmail: "bob@example.com",
      organizationId: "org-2",
      organizationName: "Globex",
      accessToken: "access-token-2",
      refreshToken: "refresh-token-2",
      expiresAt: "2026-03-27T13:00:00.000Z",
    });

    expect(client.closed).toEqual([
      { code: 4002, reason: "workspace changed" },
    ]);
  });

  it("ignores activity writes from a superseded client", async () => {
    const { bridge, ctx } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });

    const oldClient = await connectClient({ bridge, ctx }, "old");
    const newClient = await connectClient({ bridge, ctx }, "new");

    await bridge.handleActivityRequest(oldClient as unknown as WebSocket, {
      type: "activity_request",
      eventId: "req-old",
      timestamp: "2026-03-27T10:00:00.000Z",
      payload: {
        requestId: "req-old",
        instanceId: "old",
        agentSessionId: "session-1",
        clientGeneratedId: "old:response",
        content: {
          type: "response",
          body: "stale",
        },
      },
    });

    expect(createAgentActivity).not.toHaveBeenCalled();
    expect(oldClient.sent).toHaveLength(1);
    expect(readSocketActions(newClient)).toEqual(["connected"]);
  });

  it("writes activities with refreshed tokens when required", async () => {
    const { bridge, ctx } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "stale-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T10:30:00.000Z",
    });

    const client = await connectClient({ bridge, ctx }, "inst-1");

    shouldRefreshToken.mockReturnValue(true);
    refreshAccessToken.mockResolvedValue({
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: "2026-03-28T10:30:00.000Z",
    });
    createAgentActivity.mockResolvedValue({
      agentActivityId: "activity-1",
    });

    await bridge.handleActivityRequest(client as unknown as WebSocket, {
      type: "activity_request",
      eventId: "req-1",
      timestamp: "2026-03-27T10:00:00.000Z",
      payload: {
        requestId: "req-1",
        instanceId: "inst-1",
        agentSessionId: "session-1",
        clientGeneratedId: "evt-1:response",
        content: {
          type: "response",
          body: "done",
        },
      },
    });

    expect(refreshAccessToken).toHaveBeenCalledWith({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
    expect(createAgentActivity).toHaveBeenCalledWith({
      accessToken: "fresh-access-token",
      agentSessionId: "session-1",
      clientGeneratedId: "evt-1:response",
      content: {
        type: "response",
        body: "done",
      },
    });

    const activityResult = JSON.parse(client.sent.at(-1) ?? "{}") as GatewayActivityResultEnvelope;
    expect(activityResult).toMatchObject({
      type: "activity_result",
      payload: {
        requestId: "req-1",
        ok: true,
        agentSessionId: "session-1",
        agentActivityId: "activity-1",
      },
    });
  });

  it("caps buffered webhook history", async () => {
    const { bridge } = createBridge();

    await bridge.storeOAuthState({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });

    for (let index = 0; index < DEFAULT_BUFFER_MAX_ITEMS + 10; index += 1) {
      await bridge.acceptWebhookEvent(createWebhookEnvelope(`evt-${index}`));
    }

    const snapshot = await bridge.statusSnapshot();
    expect(snapshot.bufferDepth).toBe(DEFAULT_BUFFER_MAX_ITEMS);
  });
});
