export const DEFAULT_BUFFER_MAX_ITEMS = 100;
export const DEFAULT_BUFFER_MAX_AGE_MS = 60_000;
export const DEFAULT_ACTIVITY_RESULT_TIMEOUT_MS = 15_000;

export type GatewayMessageType =
  | "webhook_event"
  | "control"
  | "activity_request"
  | "activity_result";

export interface GatewayEnvelopeBase<TType extends GatewayMessageType, TPayload> {
  type: TType;
  eventId: string;
  timestamp: string;
  payload: TPayload;
}

export interface GatewayWebhookPayload {
  organizationId?: string;
  viewerId?: string;
  agentSessionId?: string;
  eventType: string;
  raw: unknown;
}

export interface GatewayControlPayload {
  action: "connected" | "ready" | "auth_fail";
  instanceId?: string;
  detail?: string;
}

export type GatewayAgentActivityContent =
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

export interface GatewayActivityRequestPayload {
  requestId: string;
  instanceId: string;
  agentSessionId: string;
  clientGeneratedId: string;
  content: GatewayAgentActivityContent;
}

export interface GatewayActivityResultPayload {
  requestId: string;
  ok: boolean;
  agentSessionId?: string;
  agentActivityId?: string | null;
  error?: string;
}

export type GatewayWebhookEnvelope = GatewayEnvelopeBase<
  "webhook_event",
  GatewayWebhookPayload
>;
export type GatewayControlEnvelope = GatewayEnvelopeBase<"control", GatewayControlPayload>;
export type GatewayActivityRequestEnvelope = GatewayEnvelopeBase<
  "activity_request",
  GatewayActivityRequestPayload
>;
export type GatewayActivityResultEnvelope = GatewayEnvelopeBase<
  "activity_result",
  GatewayActivityResultPayload
>;

export type GatewayEnvelope =
  | GatewayWebhookEnvelope
  | GatewayControlEnvelope
  | GatewayActivityRequestEnvelope
  | GatewayActivityResultEnvelope;

export interface BufferedEventPolicy {
  maxItems: number;
  maxAgeMs: number;
}

export function createStableEventId(input: {
  providedId?: string | null;
  organizationId?: string | null;
  agentSessionId?: string | null;
  eventType?: string | null;
  createdAt?: string | null;
}): string {
  if (input.providedId && input.providedId.trim()) {
    return input.providedId.trim();
  }

  const parts = [
    input.organizationId?.trim() || "unknown-org",
    input.agentSessionId?.trim() || "unknown-session",
    input.eventType?.trim() || "unknown-event",
    input.createdAt?.trim() || new Date().toISOString(),
  ];

  return parts.join(":");
}

export function createTimestamp(value?: string | Date | null): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return new Date().toISOString();
}

export function serializeEnvelope(envelope: GatewayEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(raw: string): GatewayEnvelope | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Partial<GatewayEnvelope>;
  if (
    typeof candidate.type !== "string" ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.timestamp !== "string" ||
    !candidate.payload ||
    typeof candidate.payload !== "object"
  ) {
    return null;
  }

  if (
    candidate.type !== "webhook_event" &&
    candidate.type !== "control" &&
    candidate.type !== "activity_request" &&
    candidate.type !== "activity_result"
  ) {
    return null;
  }

  return candidate as GatewayEnvelope;
}

export function pruneBufferedEvents<T extends { timestamp: string }>(
  events: T[],
  policy: BufferedEventPolicy,
  nowMs = Date.now(),
): T[] {
  const fresh = events.filter((event) => {
    const timestampMs = Date.parse(event.timestamp);
    return Number.isFinite(timestampMs) && nowMs - timestampMs <= policy.maxAgeMs;
  });

  return fresh.slice(-policy.maxItems);
}
