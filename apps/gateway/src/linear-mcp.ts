import { hasMatchingClientAuthToken, resolvePresentedClientAuthToken } from "./client-auth.js";

const MCP_ENDPOINT = "https://mcp.linear.app/mcp";
const MAX_LOG_BODY_BYTES = 2_048;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
]);

export interface LinearMcpAccessTokenProvider {
  resolveMcpProxyAccessToken(): Promise<{
    accessToken: string;
    organizationId: string;
    organizationName: string;
  }>;
}

export interface HandleLinearMcpInput {
  request: Request;
  clientAuthToken: string;
  resolveBridge: () => LinearMcpAccessTokenProvider;
}

export async function handleLinearMcp(input: HandleLinearMcpInput): Promise<Response> {
  const { request, clientAuthToken, resolveBridge } = input;
  const method = request.method.toUpperCase();

  if (!isAllowedMethod(method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, mcp-session-id",
        "access-control-max-age": "86400",
      },
    });
  }

  const providedToken = resolvePresentedClientAuthToken(request);
  if (!hasMatchingClientAuthToken(providedToken, clientAuthToken)) {
    logLinearMcpWarn("Rejected MCP proxy request with invalid client auth token.", {
      method,
      hasAuthorizationHeader: Boolean(request.headers.get("authorization")),
    });

    return Response.json(
      {
        ok: false,
        code: "unauthorized",
        message: "Unauthorized",
      },
      {
        status: 401,
        headers: {
          "www-authenticate": "Bearer",
        },
      },
    );
  }

  let accessToken: string;
  let organizationId: string;
  try {
    const resolved = await resolveBridge().resolveMcpProxyAccessToken();
    accessToken = resolved.accessToken;
    organizationId = resolved.organizationId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = isMissingInstallationError(message) ? 409 : 500;

    logLinearMcpWarn("Failed to resolve active Linear installation for MCP proxy.", {
      method,
      status,
      error: message,
    });

    return Response.json(
      {
        ok: false,
        code: status === 409 ? "installation_not_configured" : "token_unavailable",
        message,
      },
      { status },
    );
  }

  const upstreamUrl = new URL(MCP_ENDPOINT);
  const requestUrl = new URL(request.url);
  upstreamUrl.search = requestUrl.search;

  const headers = buildForwardHeaders(request.headers, accessToken);
  const requestInit: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: method === "POST" ? request.body : undefined,
  };

  if (method === "POST") {
    requestInit.duplex = "half";
  }

  try {
    const upstreamResponse = await fetch(new Request(upstreamUrl.toString(), requestInit));
    if (upstreamResponse.status >= 400) {
      void logUpstreamError(upstreamResponse.clone(), request);
    }

    logLinearMcpInfo("Forwarded MCP proxy request to Linear.", {
      method,
      organizationId,
      status: upstreamResponse.status,
    });

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: filterHopByHopHeaders(upstreamResponse.headers),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLinearMcpError("Linear MCP upstream request failed.", {
      method,
      organizationId,
      error: message,
    });

    return Response.json(
      {
        ok: false,
        code: "upstream_failed",
        message: "MCP upstream request failed",
      },
      { status: 502 },
    );
  }
}

function isAllowedMethod(method: string): boolean {
  return method === "GET" || method === "POST" || method === "OPTIONS";
}

function buildForwardHeaders(source: Headers, accessToken: string): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "authorization") {
      return;
    }
    headers.set(key, value);
  });
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}

function filterHopByHopHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

function isMissingInstallationError(message: string): boolean {
  return message.includes("not configured");
}

async function logUpstreamError(response: Response, request: Request): Promise<void> {
  try {
    const buffer = await response.arrayBuffer();
    const bodyPreview = new TextDecoder().decode(buffer.slice(0, MAX_LOG_BODY_BYTES));

    logLinearMcpWarn("Linear MCP upstream returned an error response.", {
      method: request.method,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? "unknown",
      sessionId: response.headers.get("mcp-session-id") ?? "unknown",
      bodyPreview,
      bodyTruncated: buffer.byteLength > MAX_LOG_BODY_BYTES,
    });
  } catch (error) {
    logLinearMcpWarn("Failed to read Linear MCP upstream error response.", {
      method: request.method,
      status: response.status,
      statusText: response.statusText,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function logLinearMcpInfo(message: string, meta: Record<string, unknown>): void {
  console.info(formatLinearMcpLog(message, meta));
}

function logLinearMcpWarn(message: string, meta: Record<string, unknown>): void {
  console.warn(formatLinearMcpLog(message, meta));
}

function logLinearMcpError(message: string, meta: Record<string, unknown>): void {
  console.error(formatLinearMcpLog(message, meta));
}

function formatLinearMcpLog(message: string, meta: Record<string, unknown>): string {
  const details = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatLinearMcpLogValue(value)}`)
    .join(" ");

  return details
    ? `[openclaw-linear/worker/mcp] ${message} ${details}`
    : `[openclaw-linear/worker/mcp] ${message}`;
}

function formatLinearMcpLogValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
