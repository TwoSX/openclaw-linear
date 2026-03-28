import type { AgentSessionEventWebhookPayload } from "@linear/sdk";
import {
  InternalLinearError,
  LinearClient,
  LinearError,
  LockTimeoutLinearError,
  NetworkLinearError,
  RatelimitedLinearError,
} from "@linear/sdk";
import { LinearWebhookClient } from "@linear/sdk/webhooks";

export const LINEAR_API_URL = "https://api.linear.app";
export const LINEAR_DEFAULT_SCOPES = "read,write,app:assignable,app:mentionable";

export interface LinearTokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType?: string;
  scope?: string | null;
}

export interface LinearViewerSnapshot {
  viewerId: string;
  viewerName: string | null;
  viewerEmail: string | null;
  organizationId: string;
  organizationName: string;
}

export interface LinearOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface ExchangeAuthorizationCodeInput extends LinearOAuthClientConfig {
  code: string;
}

export interface RefreshAccessTokenInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

interface ViewerQueryResponse {
  data?: {
    viewer?: {
      id: string;
      name?: string | null;
      email?: string | null;
      organization?: {
        id: string;
        name: string;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

export type LinearAgentActivityContent =
  | {
      type: "thought";
      body: string;
      ephemeral?: boolean;
    }
  | {
      type: "response";
      body: string;
    }
  | {
      type: "elicitation";
      body: string;
    }
  | {
      type: "error";
      body: string;
    }
  | {
      type: "action";
      action: string;
      parameter?: string | null;
      result?: string | null;
      ephemeral?: boolean;
    };

export interface LinearActivityWriteRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface CreateAgentActivityInput {
  accessToken: string;
  agentSessionId: string;
  content: LinearAgentActivityContent;
  id?: string;
  clientGeneratedId?: string;
  retry?: LinearActivityWriteRetryOptions;
}

type LinearAgentActivityPayload = Awaited<ReturnType<LinearClient["createAgentActivity"]>>;
type LinearAgentActivityRecord = Awaited<ReturnType<LinearClient["agentActivity"]>>;

const DEFAULT_LINEAR_ACTIVITY_WRITE_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 4,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
});

const RETRYABLE_NODE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

const RETRYABLE_ERROR_MESSAGE_SNIPPETS = [
  "connection reset",
  "fetch failed",
  "network",
  "socket hang up",
  "temporarily unavailable",
  "timed out",
  "timeout",
];

const DUPLICATE_ACTIVITY_MESSAGE_SNIPPETS = [
  "already exists",
  "already been taken",
  "duplicate",
  "must be unique",
];

export function buildOAuthAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
}): URL {
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", LINEAR_DEFAULT_SCOPES);
  url.searchParams.set("actor", "app");
  return url;
}

export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearTokenBundle> {
  const response = await fetchImpl(`${LINEAR_API_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`Linear authorization-code exchange failed: ${await response.text()}`);
  }

  const data = (await response.json()) as OAuthTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    tokenType: data.token_type,
    scope: data.scope ?? null,
  };
}

export async function refreshAccessToken(
  input: RefreshAccessTokenInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearTokenBundle> {
  const response = await fetchImpl(`${LINEAR_API_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Linear refresh-token exchange failed: ${await response.text()}`);
  }

  const data = (await response.json()) as OAuthTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    tokenType: data.token_type,
    scope: data.scope ?? null,
  };
}

export function shouldRefreshToken(expiresAt: string, bufferSeconds = 300): boolean {
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) {
    return true;
  }
  return expiryMs - Date.now() <= bufferSeconds * 1000;
}

export async function fetchViewerSnapshot(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearViewerSnapshot> {
  const response = await fetchImpl(`${LINEAR_API_URL}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `
        query ViewerSnapshot {
          viewer {
            id
            name
            email
            organization {
              id
              name
            }
          }
        }
      `,
    }),
  });

  if (!response.ok) {
    throw new Error(`Linear viewer query failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ViewerQueryResponse;
  if (data.errors?.length) {
    throw new Error(data.errors.map((error) => error.message || "unknown error").join("; "));
  }

  const viewer = data.data?.viewer;
  const organization = viewer?.organization;
  if (!viewer?.id || !organization?.id || !organization.name) {
    throw new Error("Linear viewer query did not return organization identity.");
  }

  return {
    viewerId: viewer.id,
    viewerName: viewer.name ?? null,
    viewerEmail: viewer.email ?? null,
    organizationId: organization.id,
    organizationName: organization.name,
  };
}

export function createLinearClient(accessToken: string): LinearClient {
  return new LinearClient({
    accessToken,
  });
}

export async function createAgentActivity(
  input: CreateAgentActivityInput,
): Promise<LinearAgentActivityPayload> {
  const client = createLinearClient(input.accessToken);
  const retryOptions = normalizeLinearActivityWriteRetryOptions(input.retry);
  const activityId = resolveLinearActivityWriteId(input);

  for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
    try {
      return await client.createAgentActivity({
        agentSessionId: input.agentSessionId,
        content: input.content as never,
        id: activityId,
      });
    } catch (error) {
      if (shouldAttemptExistingActivityRecovery(error)) {
        const existingActivity = await tryFetchExistingAgentActivity(client, activityId);
        if (existingActivity) {
          return createRecoveredAgentActivityPayload(existingActivity);
        }
      }

      if (attempt >= retryOptions.maxAttempts || !isRetryableLinearActivityWriteError(error)) {
        throw error;
      }

      await waitForRetryDelay(calculateLinearActivityRetryDelayMs(attempt, error, retryOptions));
    }
  }

  throw new Error("Linear activity write exhausted without returning or throwing.");
}

export function createLinearWebhookHandler(secret: string) {
  return new LinearWebhookClient(secret).createHandler();
}

export type {
  AgentSessionEventWebhookPayload,
};

function normalizeLinearActivityWriteRetryOptions(
  retry: LinearActivityWriteRetryOptions | undefined,
): Required<LinearActivityWriteRetryOptions> {
  return {
    maxAttempts: normalizePositiveInteger(
      retry?.maxAttempts,
      DEFAULT_LINEAR_ACTIVITY_WRITE_RETRY_OPTIONS.maxAttempts,
    ),
    initialDelayMs: normalizeNonNegativeInteger(
      retry?.initialDelayMs,
      DEFAULT_LINEAR_ACTIVITY_WRITE_RETRY_OPTIONS.initialDelayMs,
    ),
    maxDelayMs: Math.max(
      normalizeNonNegativeInteger(
        retry?.maxDelayMs,
        DEFAULT_LINEAR_ACTIVITY_WRITE_RETRY_OPTIONS.maxDelayMs,
      ),
      normalizeNonNegativeInteger(
        retry?.initialDelayMs,
        DEFAULT_LINEAR_ACTIVITY_WRITE_RETRY_OPTIONS.initialDelayMs,
      ),
    ),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function resolveLinearActivityWriteId(
  input: Pick<CreateAgentActivityInput, "agentSessionId" | "id" | "clientGeneratedId">,
): string {
  const explicitId = input.id?.trim();
  if (explicitId) {
    return explicitId;
  }

  const clientGeneratedId = input.clientGeneratedId?.trim();
  if (!clientGeneratedId) {
    return crypto.randomUUID();
  }

  if (isUuidLike(clientGeneratedId)) {
    return clientGeneratedId;
  }

  return createDeterministicUuid(`${input.agentSessionId}:${clientGeneratedId}`);
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createDeterministicUuid(value: string): string {
  const bytes = hashStringToUuidBytes(value);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function shouldAttemptExistingActivityRecovery(error: unknown): boolean {
  return isRetryableLinearActivityWriteError(error) || isLikelyDuplicateActivityWriteError(error);
}

function isRetryableLinearActivityWriteError(error: unknown): boolean {
  if (
    error instanceof RatelimitedLinearError ||
    error instanceof NetworkLinearError ||
    error instanceof InternalLinearError ||
    error instanceof LockTimeoutLinearError
  ) {
    return true;
  }

  if (error instanceof LinearError) {
    return error.status === 429 || (typeof error.status === "number" && error.status >= 500);
  }

  const nodeCode = extractNodeErrorCode(error);
  if (nodeCode && RETRYABLE_NODE_ERROR_CODES.has(nodeCode)) {
    return true;
  }

  const message = extractErrorMessage(error);
  return RETRYABLE_ERROR_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet));
}

function isLikelyDuplicateActivityWriteError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return DUPLICATE_ACTIVITY_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet));
}

function extractNodeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }

  return String(error).toLowerCase();
}

async function tryFetchExistingAgentActivity(
  client: LinearClient,
  activityId: string,
): Promise<LinearAgentActivityRecord | null> {
  try {
    return await client.agentActivity(activityId);
  } catch {
    return null;
  }
}

function createRecoveredAgentActivityPayload(
  activity: LinearAgentActivityRecord,
): LinearAgentActivityPayload {
  return {
    success: true,
    lastSyncId: 0,
    agentActivityId: activity.id,
    agentActivity: Promise.resolve(activity),
  } as unknown as LinearAgentActivityPayload;
}

async function waitForRetryDelay(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function calculateLinearActivityRetryDelayMs(
  attempt: number,
  error: unknown,
  options: Required<LinearActivityWriteRetryOptions>,
): number {
  const retryAfter = error instanceof RatelimitedLinearError ? error.retryAfter : undefined;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, options.maxDelayMs);
  }

  const exponentialDelay = options.initialDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponentialDelay, options.maxDelayMs);
}

function hashStringToUuidBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(16);

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes[index % 16] = (bytes[index % 16] * 31 + code) & 0xff;
  }

  return bytes;
}
