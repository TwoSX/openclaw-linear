import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
import {
  buildOAuthAuthorizeUrl,
  createLinearWebhookHandler,
  exchangeAuthorizationCode,
  fetchViewerSnapshot,
} from "./linear-api.js";
import { handleLinearMcp as proxyLinearMcp } from "./linear-mcp.js";
import {
  createStableEventId,
  createTimestamp,
  type GatewayWebhookEnvelope,
} from "../../../shared/protocol.js";
import { LinearBridgeDurableObject } from "./bridge-do.js";

export { LinearBridgeDurableObject } from "./bridge-do.js";

export interface Env {
  LINEAR_BRIDGE: DurableObjectNamespace<LinearBridgeDurableObject>;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;
  CLIENT_AUTH_TOKEN: string;
}

const BRIDGE_NAME = "openclaw-linear";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const OAUTH_STATE_COOKIE = "openclaw_linear_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json(
        {
          ok: true,
          service: "openclaw-linear-gateway",
        },
        {
          headers: JSON_HEADERS,
        },
      );
    }

    if (request.method === "GET" && url.pathname === "/oauth/authorize") {
      const state = crypto.randomUUID();
      const gatewayBaseUrl = getRequestBaseUrl(request);
      const redirect = buildOAuthAuthorizeUrl({
        clientId: env.LINEAR_CLIENT_ID,
        redirectUri: `${gatewayBaseUrl}/oauth/callback`,
      });
      redirect.searchParams.set("state", state);

      return new Response(null, {
        status: 302,
        headers: {
          location: redirect.toString(),
          "set-cookie": buildCookieHeader(OAUTH_STATE_COOKIE, state, {
            maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
            path: "/oauth/callback",
            httpOnly: true,
            sameSite: "Lax",
            secure: isSecureRequest(request),
          }),
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      return await handleOAuthCallback(request, env);
    }

    if (request.method === "POST" && url.pathname === "/linear/webhook") {
      return await handleLinearWebhook(request, env, ctx);
    }

    if (url.pathname === "/linear/mcp") {
      return await handleLinearMcp(request, env);
    }

    if (url.pathname === "/ws") {
      return await handleWebSocketUpgrade(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const gatewayBaseUrl = getRequestBaseUrl(request);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const returnedState = url.searchParams.get("state")?.trim() ?? "";
  const expectedState = parseCookieHeader(request.headers.get("cookie")).get(OAUTH_STATE_COOKIE) ?? "";

  if (error) {
    logWorkerWarn("Linear OAuth callback returned an error.", {
      error,
    });
    return withCookie(
      new Response(`<h1>Linear OAuth Error</h1><p>${escapeHtml(error)}</p>`, {
        status: 400,
        headers: HTML_HEADERS,
      }),
      buildCookieHeader(OAUTH_STATE_COOKIE, "", {
        maxAge: 0,
        path: "/oauth/callback",
        httpOnly: true,
        sameSite: "Lax",
        secure: isSecureRequest(request),
      }),
    );
  }

  if (!returnedState || !expectedState || returnedState !== expectedState) {
    logWorkerWarn("Rejected OAuth callback with invalid state token.", {
      expectedStatePresent: Boolean(expectedState),
      returnedStatePresent: Boolean(returnedState),
    });
    return withCookie(
      new Response("<h1>Invalid OAuth state</h1><p>Please start the OAuth flow again.</p>", {
        status: 400,
        headers: HTML_HEADERS,
      }),
      buildCookieHeader(OAUTH_STATE_COOKIE, "", {
        maxAge: 0,
        path: "/oauth/callback",
        httpOnly: true,
        sameSite: "Lax",
        secure: isSecureRequest(request),
      }),
    );
  }

  if (!code) {
    logWorkerWarn("Rejected OAuth callback without authorization code.", {});
    return withCookie(
      new Response("<h1>Missing code</h1>", {
        status: 400,
        headers: HTML_HEADERS,
      }),
      buildCookieHeader(OAUTH_STATE_COOKIE, "", {
        maxAge: 0,
        path: "/oauth/callback",
        httpOnly: true,
        sameSite: "Lax",
        secure: isSecureRequest(request),
      }),
    );
  }

  const clearOAuthStateCookie = buildCookieHeader(OAUTH_STATE_COOKIE, "", {
    maxAge: 0,
    path: "/oauth/callback",
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(request),
  });

  try {
    const tokenBundle = await exchangeAuthorizationCode({
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
      redirectUri: `${gatewayBaseUrl}/oauth/callback`,
      code,
    });

    const viewer = await fetchViewerSnapshot(tokenBundle.accessToken);
    await getBridge(env).storeOAuthState({
      ...viewer,
      ...tokenBundle,
    });

    logWorkerInfo("Stored active Linear installation after OAuth callback.", {
      organizationId: viewer.organizationId,
      organizationName: viewer.organizationName,
      viewerId: viewer.viewerId,
    });

    const channelConfigSeed = {
      channels: {
        linear: {
          enabled: true,
          gatewayBaseUrl,
          clientAuthToken: env.CLIENT_AUTH_TOKEN,
          healthMonitor: {
            enabled: false,
          },
        },
      },
    };

    return withCookie(
      new Response(renderOAuthSuccessPage(viewer, channelConfigSeed), {
        status: 200,
        headers: HTML_HEADERS,
      }),
      clearOAuthStateCookie,
    );
  } catch (error) {
    return withCookie(
      new Response(
        `<h1>OAuth callback failed</h1><pre>${escapeHtml(String(error))}</pre>`,
        {
          status: 500,
          headers: HTML_HEADERS,
        },
      ),
      clearOAuthStateCookie,
    );
  }
}

function getRequestBaseUrl(request: Request): string {
  return new URL(request.url).origin;
}

async function handleLinearWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const handler = createLinearWebhookHandler(env.LINEAR_WEBHOOK_SECRET);

  handler.on("*", (payload) => {
    if (isAgentSessionEventPayload(payload)) {
      return;
    }

    logWorkerInfo("Ignoring unsupported Linear webhook payload.", {
      payloadType: deriveLinearWebhookPayloadType(payload),
      action: deriveGenericWebhookAction(payload),
      webhookId: deriveGenericWebhookId(payload),
    });
  });

  handler.on("AgentSessionEvent", (payload: AgentSessionEventWebhookPayload) => {
    logWorkerInfo("Received Linear AgentSessionEvent webhook.", {
      action: payload.action,
      agentSessionId: payload.agentSession?.id ?? "unknown",
      organizationId: payload.organizationId,
      webhookId: payload.webhookId,
    });
    ctx.waitUntil(dispatchAgentSessionEvent(payload, env));
  });

  const response = await handler(request);
  if (!response.ok) {
    logWorkerWarn("Linear webhook request rejected.", {
      status: response.status,
      statusText: response.statusText,
    });
  }

  return response;
}

async function handleWebSocketUpgrade(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get("upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    logWorkerWarn("Rejected non-WebSocket request on /ws.", {
      method: request.method,
      upgrade: upgradeHeader ?? "missing",
    });
    return new Response("Durable Object expected Upgrade: websocket", { status: 426 });
  }

  logWorkerInfo("Routing WebSocket upgrade to bridge Durable Object.", {
    instanceId: new URL(request.url).searchParams.get("instanceId") ?? "unknown",
  });
  return await getBridge(env).fetch(request);
}

async function handleLinearMcp(request: Request, env: Env): Promise<Response> {
  return await proxyLinearMcp({
    request,
    clientAuthToken: env.CLIENT_AUTH_TOKEN,
    resolveBridge: () => getBridge(env),
  });
}

async function dispatchAgentSessionEvent(
  payload: AgentSessionEventWebhookPayload,
  env: Env,
): Promise<void> {
  const organizationId = payload.organizationId;
  if (!organizationId) {
    logWorkerWarn("Skipping AgentSessionEvent without organizationId.", {
      action: payload.action,
      agentSessionId: payload.agentSession?.id ?? "unknown",
      webhookId: payload.webhookId,
    });
    return;
  }

  const eventType = deriveAgentSessionEventType(payload);
  const agentSessionId = payload.agentSession?.id ?? "";
  const timestamp = createTimestamp(payload.createdAt);
  const eventId = createStableEventId({
    providedId: (payload as { id?: string | null }).id ?? null,
    organizationId,
    agentSessionId,
    eventType,
    createdAt: timestamp,
  });

  const envelope: GatewayWebhookEnvelope = {
    type: "webhook_event",
    eventId,
    timestamp,
    payload: {
      organizationId,
      agentSessionId,
      eventType,
      raw: payload,
    },
  };

  logWorkerInfo("Dispatching AgentSessionEvent to bridge Durable Object.", {
    organizationId,
    eventId,
    eventType,
    agentSessionId: agentSessionId || "unknown",
  });

  try {
    const result = await getBridge(env).acceptWebhookEvent(envelope);
    logWorkerInfo("Bridge Durable Object processed AgentSessionEvent.", {
      organizationId,
      eventId,
      eventType,
      ignored: result.ignored,
      duplicate: result.duplicate,
      buffered: result.buffered,
      delivered: result.delivered,
      clientConnected: result.clientConnected,
      clientReady: result.clientReady,
      bufferDepth: result.bufferDepth,
      installationConfigured: result.installationConfigured,
    });
  } catch (error) {
    logWorkerError("Failed to dispatch AgentSessionEvent to bridge Durable Object.", {
      organizationId,
      eventId,
      eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function deriveAgentSessionEventType(payload: AgentSessionEventWebhookPayload): string {
  const raw = payload as unknown as {
    action?: string;
    eventType?: string;
    type?: string;
  };

  return raw.action || raw.eventType || raw.type || "unknown";
}

function isAgentSessionEventPayload(payload: unknown): payload is AgentSessionEventWebhookPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  return "agentSession" in payload && "organizationId" in payload;
}

function deriveLinearWebhookPayloadType(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "unknown";
  }

  const type = (payload as { type?: unknown }).type;
  return typeof type === "string" && type.trim() ? type : "unknown";
}

function deriveGenericWebhookAction(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "unknown";
  }

  const action = (payload as { action?: unknown }).action;
  return typeof action === "string" && action.trim() ? action : "unknown";
}

function deriveGenericWebhookId(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "unknown";
  }

  const webhookId = (payload as { webhookId?: unknown }).webhookId;
  return typeof webhookId === "string" && webhookId.trim() ? webhookId : "unknown";
}

function renderOAuthSuccessPage(
  viewer: Awaited<ReturnType<typeof fetchViewerSnapshot>>,
  channelConfigSeed: Record<string, unknown>,
): string {
  const jsonSeed = renderJsonSeed(channelConfigSeed);
  const installCommands = renderShellCommands([
    "openclaw plugins install openclaw-channel-linear",
    "openclaw gateway restart",
  ]);
  const configCommands = renderShellCommands([
    "openclaw config set channels.linear.enabled true --strict-json",
    `openclaw config set channels.linear.gatewayBaseUrl '${JSON.stringify(viewerGatewayBaseUrl(channelConfigSeed))}' --strict-json`,
    `openclaw config set channels.linear.clientAuthToken '${JSON.stringify(viewerClientAuthToken(channelConfigSeed))}' --strict-json`,
    "openclaw config set channels.linear.healthMonitor.enabled false --strict-json",
    "openclaw gateway restart",
  ]);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw Linear OAuth Success</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f6f2;
        --card: #ffffff;
        --ink: #14213d;
        --muted: #5f6b7a;
        --accent: #c8553d;
        --line: #e6dfd4;
      }
      body {
        margin: 0;
        padding: 32px;
        background:
          radial-gradient(circle at top right, rgba(200, 85, 61, 0.12), transparent 30%),
          linear-gradient(180deg, #faf7f2 0%, var(--bg) 100%);
        color: var(--ink);
        font: 15px/1.6 "IBM Plex Sans", "Segoe UI", sans-serif;
      }
      main {
        max-width: 920px;
        margin: 0 auto;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 28px;
        box-shadow: 0 18px 42px rgba(20, 33, 61, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 30px;
      }
      p {
        margin: 0 0 12px;
        color: var(--muted);
      }
      pre {
        overflow: auto;
        padding: 18px;
        border-radius: 16px;
        background: #111827;
        color: #e5f2ff;
        border: 1px solid #263144;
      }
      code {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
      .note {
        margin-top: 18px;
        padding: 14px 16px;
        border-left: 4px solid var(--accent);
        background: rgba(200, 85, 61, 0.07);
        color: var(--ink);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Linear OAuth Success</h1>
      <p>Workspace: <strong>${escapeHtml(viewer.organizationName)}</strong></p>
      <p>Viewer ID: <code>${escapeHtml(viewer.viewerId)}</code></p>
      <p>Organization ID: <code>${escapeHtml(viewer.organizationId)}</code></p>
      <p>The Worker has already stored the active Linear installation for this deployment.</p>
      <p>If the local OpenClaw plugin is not installed yet, run:</p>
      <pre><code>${escapeHtml(installCommands)}</code></pre>
      <p>Next, configure <code>channels.linear</code> in OpenClaw with the values below.</p>
      <pre><code>${escapeHtml(jsonSeed)}</code></pre>
      <p>Then restart the local OpenClaw gateway:</p>
      <pre><code>${escapeHtml(configCommands)}</code></pre>
      <div class="note">
        This deployment only serves one active Linear organization at a time. A new OAuth callback
        will overwrite the active installation and disconnect the currently connected client.
      </div>
    </main>
  </body>
</html>`;
}

function renderJsonSeed(channelConfigSeed: Record<string, unknown>): string {
  return JSON.stringify(channelConfigSeed, null, 2);
}

function renderShellCommands(lines: string[]): string {
  return lines.join("\n");
}

function viewerGatewayBaseUrl(channelConfigSeed: Record<string, unknown>): string {
  return (
    ((channelConfigSeed.channels as { linear?: { gatewayBaseUrl?: string } } | undefined)?.linear
      ?.gatewayBaseUrl as string | undefined) ?? ""
  );
}

function viewerClientAuthToken(channelConfigSeed: Record<string, unknown>): string {
  return (
    ((channelConfigSeed.channels as { linear?: { clientAuthToken?: string } } | undefined)?.linear
      ?.clientAuthToken as string | undefined) ?? ""
  );
}

function getBridge(env: Env) {
  return env.LINEAR_BRIDGE.getByName(BRIDGE_NAME);
}

function parseCookieHeader(raw: string | null): Map<string, string> {
  const cookies = new Map<string, string>();

  if (!raw) {
    return cookies;
  }

  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    cookies.set(key, decodeURIComponent(value));
  }

  return cookies;
}

function buildCookieHeader(
  name: string,
  value: string,
  options: {
    maxAge: number;
    path: string;
    httpOnly: boolean;
    sameSite: "Lax" | "Strict" | "None";
    secure: boolean;
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${options.maxAge}`, `Path=${options.path}`, `SameSite=${options.sameSite}`];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function withCookie(response: Response, cookieHeader: string): Response {
  response.headers.append("set-cookie", cookieHeader);
  return response;
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function logWorkerInfo(message: string, meta: Record<string, unknown>): void {
  console.info(formatWorkerLog(message, meta));
}

function logWorkerWarn(message: string, meta: Record<string, unknown>): void {
  console.warn(formatWorkerLog(message, meta));
}

function logWorkerError(message: string, meta: Record<string, unknown>): void {
  console.error(formatWorkerLog(message, meta));
}

function formatWorkerLog(message: string, meta: Record<string, unknown>): string {
  const details = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatWorkerLogValue(value)}`)
    .join(" ");

  return details
    ? `[openclaw-linear/worker] ${message} ${details}`
    : `[openclaw-linear/worker] ${message}`;
}

function formatWorkerLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}
