import {
  createStableEventId,
  type GatewayWebhookEnvelope,
} from "../../../shared/protocol.js";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildOAuthAuthorizeUrl = vi.fn();
const exchangeAuthorizationCode = vi.fn();
const fetchViewerSnapshot = vi.fn();
const bridgeFetch = vi.fn();
const bridgeAcceptWebhookEvent = vi.fn();
const bridgeStoreOAuthState = vi.fn();
const bridgeResolveMcpProxyAccessToken = vi.fn();
const getByName = vi.fn(() => ({
  fetch: bridgeFetch,
  acceptWebhookEvent: bridgeAcceptWebhookEvent,
  storeOAuthState: bridgeStoreOAuthState,
  resolveMcpProxyAccessToken: bridgeResolveMcpProxyAccessToken,
}));

let webhookDispatch:
  | {
      eventType: string;
      payload: unknown;
    }
  | null = null;
let webhookResponse = Response.json({ ok: true });

const createLinearWebhookHandler = vi.fn(() => {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();

  const handler = async (_request: Request): Promise<Response> => {
    if (webhookDispatch) {
      const dispatch = webhookDispatch;
      listeners.get("*")?.forEach((callback) => callback(dispatch.payload));
      listeners.get(dispatch.eventType)?.forEach((callback) => callback(dispatch.payload));
    }
    return webhookResponse;
  };

  return Object.assign(handler, {
    on(event: string, callback: (payload: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
    },
  });
});

vi.mock("./linear-api.js", () => ({
  buildOAuthAuthorizeUrl,
  createLinearWebhookHandler,
  exchangeAuthorizationCode,
  fetchViewerSnapshot,
}));

vi.mock("./bridge-do.js", () => ({
  LinearBridgeDurableObject: class LinearBridgeDurableObject {},
}));

const { default: worker } = await import("./index.js");

interface TestExecutionContext extends ExecutionContext {
  readonly pending: Promise<unknown>[];
}

type WorkerEnv = Parameters<(typeof worker)["fetch"]>[1];

function createEnv(): WorkerEnv {
  return {
    LINEAR_BRIDGE: {
      getByName,
    },
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
    CLIENT_AUTH_TOKEN: "client-token",
  } as unknown as WorkerEnv;
}

function createExecutionContext(): TestExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  } as TestExecutionContext;
}

describe("worker fetch", () => {
  beforeEach(() => {
    webhookDispatch = null;
    webhookResponse = Response.json({ ok: true });
    bridgeFetch.mockReset();
    bridgeFetch.mockResolvedValue(Response.json({ ok: true }));
    bridgeAcceptWebhookEvent.mockReset();
    bridgeAcceptWebhookEvent.mockResolvedValue({
      ignored: false,
      duplicate: false,
      buffered: false,
      delivered: true,
      clientConnected: true,
      clientReady: true,
      bufferDepth: 0,
      installationConfigured: true,
    });
    bridgeStoreOAuthState.mockReset();
    bridgeStoreOAuthState.mockResolvedValue({
      ok: true,
      organizationId: "org-1",
      organizationName: "Acme",
    });
    bridgeResolveMcpProxyAccessToken.mockReset();
    bridgeResolveMcpProxyAccessToken.mockResolvedValue({
      accessToken: "linear-access-token",
      organizationId: "org-1",
      organizationName: "Acme",
    });
    getByName.mockClear();
    createLinearWebhookHandler.mockClear();
    buildOAuthAuthorizeUrl.mockReset();
    exchangeAuthorizationCode.mockReset();
    fetchViewerSnapshot.mockReset();
  });

  it("routes websocket requests to the fixed bridge durable object", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();

    bridgeFetch.mockResolvedValueOnce(new Response("bridge", { status: 200 }));
    const response = await worker.fetch(
      new Request("https://worker.example/ws?instanceId=inst-1", {
        headers: {
          upgrade: "websocket",
        },
      }),
      env,
      ctx,
    );

    expect(getByName).toHaveBeenCalledWith("openclaw-linear");
    expect(bridgeFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bridge");
  });

  it("starts OAuth with a state cookie and forwards that state to Linear", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    buildOAuthAuthorizeUrl.mockReturnValueOnce(
      new URL("https://linear.app/oauth/authorize?client_id=client-id"),
    );

    const response = await worker.fetch(
      new Request("https://worker.example/oauth/authorize"),
      env,
      ctx,
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("https://linear.app/oauth/authorize");
    const redirect = new URL(location!);
    const state = redirect.searchParams.get("state");
    expect(state).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.headers.get("set-cookie")).toContain(`openclaw_linear_oauth_state=${state}`);
  });

  it("rejects non-WebSocket requests on /ws before they reach the durable object", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/ws"),
      env,
      ctx,
    );

    expect(response.status).toBe(426);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("delivers AgentSessionEvent webhooks to the fixed bridge durable object", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const payload = {
      id: "evt-123",
      createdAt: "2026-03-27T10:00:00.000Z",
      organizationId: "org-456",
      action: "session.updated",
      agentSession: {
        id: "session-789",
      },
    } as unknown as AgentSessionEventWebhookPayload;
    webhookDispatch = {
      eventType: "AgentSessionEvent",
      payload,
    };

    const response = await worker.fetch(
      new Request("https://worker.example/linear/webhook", { method: "POST" }),
      env,
      ctx,
    );
    await Promise.all(ctx.pending);

    expect(response.status).toBe(200);
    expect(createLinearWebhookHandler).toHaveBeenCalledWith("webhook-secret");
    expect(getByName).toHaveBeenCalledWith("openclaw-linear");

    const [envelope] = bridgeAcceptWebhookEvent.mock.calls[0] as [GatewayWebhookEnvelope];
    expect(envelope).toMatchObject({
      type: "webhook_event",
      eventId: createStableEventId({
        providedId: "evt-123",
        organizationId: "org-456",
        agentSessionId: "session-789",
        eventType: "session.updated",
        createdAt: "2026-03-27T10:00:00.000Z",
      }),
      timestamp: "2026-03-27T10:00:00.000Z",
      payload: {
        organizationId: "org-456",
        agentSessionId: "session-789",
        eventType: "session.updated",
        raw: payload,
      },
    });
  });

  it("ignores unsupported Linear webhook payload types", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    webhookDispatch = {
      eventType: "Issue",
      payload: {
        type: "IssueWebhookPayload",
        action: "create",
        webhookId: "webhook-123",
      },
    };

    const response = await worker.fetch(
      new Request("https://worker.example/linear/webhook", { method: "POST" }),
      env,
      ctx,
    );
    await Promise.all(ctx.pending);

    expect(response.status).toBe(200);
    expect(bridgeAcceptWebhookEvent).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring unsupported Linear webhook payload."),
    );

    infoSpy.mockRestore();
  });

  it("renders a channels.linear config snippet after OAuth callback success", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();

    exchangeAuthorizationCode.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });
    fetchViewerSnapshot.mockResolvedValue({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
    });

    const response = await worker.fetch(
      new Request("https://worker.example/oauth/callback?code=oauth-code&state=expected-state", {
        headers: {
          cookie: "openclaw_linear_oauth_state=expected-state",
        },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);

    const html = await response.text();
    expect(bridgeStoreOAuthState).toHaveBeenCalledWith({
      viewerId: "viewer-1",
      viewerName: "Alice",
      viewerEmail: "alice@example.com",
      organizationId: "org-1",
      organizationName: "Acme",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-03-27T12:00:00.000Z",
    });
    expect(html).toContain("&quot;channels&quot;");
    expect(html).toContain("&quot;linear&quot;");
    expect(html).toContain("&quot;gatewayBaseUrl&quot;: &quot;https://worker.example&quot;");
    expect(html).toContain("&quot;clientAuthToken&quot;: &quot;client-token&quot;");
    expect(html).toContain("openclaw plugins install openclaw-channel-linear");
    expect(html).toContain("openclaw config set channels.linear.enabled true --strict-json");
    expect(html).toContain("openclaw gateway restart");
    expect(html).not.toContain("organizationId");
    expect(html).not.toContain("roomKey");
    expect(html).not.toContain("instanceId");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rejects OAuth callbacks with a missing or mismatched state token", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/oauth/callback?code=oauth-code&state=unexpected", {
        headers: {
          cookie: "openclaw_linear_oauth_state=expected-state",
        },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid OAuth state");
    expect(bridgeStoreOAuthState).not.toHaveBeenCalled();
  });

  it("skips room delivery when the webhook payload has no organizationId", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    webhookDispatch = {
      eventType: "AgentSessionEvent",
      payload: {
        createdAt: "2026-03-27T10:05:00.000Z",
        action: "session.updated",
        agentSession: {
          id: "session-789",
        },
      } as unknown as AgentSessionEventWebhookPayload,
    };

    await worker.fetch(
      new Request("https://worker.example/linear/webhook", { method: "POST" }),
      env,
      ctx,
    );
    await Promise.all(ctx.pending);

    expect(getByName).not.toHaveBeenCalled();
    expect(bridgeAcceptWebhookEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping AgentSessionEvent without organizationId."),
    );

    warnSpy.mockRestore();
  });

  it("responds to MCP preflight requests without touching the bridge", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/linear/mcp", {
        method: "OPTIONS",
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(getByName).not.toHaveBeenCalled();
    expect(bridgeResolveMcpProxyAccessToken).not.toHaveBeenCalled();
  });

  it("rejects unauthorized MCP proxy requests", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request("https://worker.example/linear/mcp", {
        method: "GET",
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(getByName).not.toHaveBeenCalled();
    expect(bridgeResolveMcpProxyAccessToken).not.toHaveBeenCalled();
  });

  it("proxies MCP requests through the active Linear installation token", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("stream", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "mcp-session-id": "mcp-session-1",
        },
      }),
    );

    const response = await worker.fetch(
      new Request("https://worker.example/linear/mcp?transport=sse", {
        method: "GET",
        headers: {
          authorization: "Bearer client-token",
          connection: "keep-alive",
          "mcp-session-id": "existing-session",
        },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("stream");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("connection")).toBeNull();
    expect(bridgeResolveMcpProxyAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [upstreamRequest] = fetchSpy.mock.calls[0] as [Request];
    expect(upstreamRequest.url).toBe("https://mcp.linear.app/mcp?transport=sse");
    expect(upstreamRequest.headers.get("authorization")).toBe("Bearer linear-access-token");
    expect(upstreamRequest.headers.get("mcp-session-id")).toBe("existing-session");
    expect(upstreamRequest.headers.get("connection")).toBeNull();

    fetchSpy.mockRestore();
  });

  it("returns a 409 MCP error when no active installation is configured", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    bridgeResolveMcpProxyAccessToken.mockRejectedValueOnce(
      new Error("Linear installation is not configured."),
    );

    const response = await worker.fetch(
      new Request("https://worker.example/linear/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0" }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "installation_not_configured",
    });
  });
});
