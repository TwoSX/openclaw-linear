import WebSocket, { type RawData } from "ws";
import {
  DEFAULT_ACTIVITY_RESULT_TIMEOUT_MS,
  parseEnvelope,
  serializeEnvelope,
  type GatewayActivityRequestEnvelope,
  type GatewayActivityResultEnvelope,
  type GatewayAgentActivityContent,
  type GatewayControlEnvelope,
  type GatewayEnvelope,
  type GatewayWebhookEnvelope,
} from "./protocol.js";
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_RUNTIME_INSTANCE_ID = `openclaw-${crypto.randomUUID()}`;

export interface OpenClawLinearPluginConfig {
  gatewayBaseUrl: string;
  clientAuthToken: string;
  promptContextTemplate?: string;
  debugTranscriptTrace?: boolean;
}

export interface ResolvedOpenClawLinearPluginConfig extends OpenClawLinearPluginConfig {
  instanceId: string;
}

export interface GatewayActivityWriteInput {
  agentSessionId: string;
  clientGeneratedId: string;
  content: GatewayAgentActivityContent;
  timeoutMs?: number;
}

export interface GatewayActivityWriter {
  writeActivity(input: GatewayActivityWriteInput): Promise<GatewayActivityResultEnvelope["payload"]>;
}

interface PendingActivityRequest {
  resolve: (payload: GatewayActivityResultEnvelope["payload"]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LinearGatewaySocketOptions {
  pingIntervalMs?: number;
  onOpen?: () => void;
  onClose?: (event: { code: number; reason: string }) => void;
  onWebhookEvent?: (event: GatewayWebhookEnvelope) => void;
  onControl?: (event: GatewayControlEnvelope) => void;
  onError?: (error: unknown) => void;
}

export function resolveRuntimePluginConfig(
  config: OpenClawLinearPluginConfig,
): ResolvedOpenClawLinearPluginConfig {
  return {
    ...config,
    instanceId: DEFAULT_RUNTIME_INSTANCE_ID,
  };
}

export function buildGatewayWebSocketUrl(config: ResolvedOpenClawLinearPluginConfig): string {
  const base = new URL(config.gatewayBaseUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws";
  base.searchParams.set("instanceId", config.instanceId);
  base.searchParams.set("clientAuthToken", config.clientAuthToken);
  return base.toString();
}

export class LinearGatewaySocket implements GatewayActivityWriter {
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: ResolvedOpenClawLinearPluginConfig;
  private readonly options: LinearGatewaySocketOptions;
  private readonly pendingActivityRequests = new Map<string, PendingActivityRequest>();
  private activityCounter = 0;

  constructor(config: OpenClawLinearPluginConfig, options: LinearGatewaySocketOptions = {}) {
    this.config = resolveRuntimePluginConfig(config);
    this.options = options;
  }

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const nextSocket = new WebSocket(buildGatewayWebSocketUrl(this.config));
    this.socket = nextSocket;

    nextSocket.on("open", () => {
      if (this.socket !== nextSocket) {
        return;
      }

      this.options.onOpen?.();
      this.sendControl("ready");
      this.startPingLoop();
    });

    nextSocket.on("message", (data: RawData) => {
      this.handleSocketMessage(data);
    });

    nextSocket.on("close", (code: number, reasonBuffer: Buffer) => {
      if (this.socket === nextSocket) {
        this.socket = null;
      }

      this.stopPingLoop();
      this.rejectPendingActivityRequests(
        new Error(`Gateway socket closed (${code}) ${reasonBuffer.toString() || "no reason"}`),
      );
      this.options.onClose?.({
        code,
        reason: reasonBuffer.toString(),
      });
    });

    nextSocket.on("error", (error: Error) => {
      this.options.onError?.(error);
    });
  }

  disconnect(code = 1000, reason = "client disconnect"): void {
    this.stopPingLoop();
    this.rejectPendingActivityRequests(new Error(`Gateway socket closed: ${reason}`));
    this.socket?.close(code, reason);
    this.socket = null;
  }

  send(envelope: GatewayEnvelope): void {
    this.requireOpenSocket().send(serializeEnvelope(envelope));
  }

  sendControl(action: GatewayControlEnvelope["payload"]["action"], detail?: string): void {
    this.send({
      type: "control",
      eventId: `ctrl:${this.config.instanceId}:${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: {
        action,
        instanceId: this.config.instanceId,
        detail,
      },
    });
  }

  async writeActivity(
    input: GatewayActivityWriteInput,
  ): Promise<GatewayActivityResultEnvelope["payload"]> {
    const requestId = this.createActivityRequestId();
    const timeoutMs = normalizeTimeoutMs(input.timeoutMs);

    return await new Promise<GatewayActivityResultEnvelope["payload"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActivityRequests.delete(requestId);
        reject(
          new Error(`Timed out waiting for gateway activity result after ${timeoutMs}ms.`),
        );
      }, timeoutMs);

      this.pendingActivityRequests.set(requestId, { resolve, reject, timer });

      try {
        const envelope: GatewayActivityRequestEnvelope = {
          type: "activity_request",
          eventId: requestId,
          timestamp: new Date().toISOString(),
          payload: {
            requestId,
            instanceId: this.config.instanceId,
            agentSessionId: input.agentSessionId,
            clientGeneratedId: input.clientGeneratedId,
            content: input.content,
          },
        };
        this.send(envelope);
      } catch (error) {
        clearTimeout(timer);
        this.pendingActivityRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleSocketMessage(data: RawData): void {
    const raw = normalizeRawData(data);
    if (!raw) {
      return;
    }

    const parsed = parseEnvelope(raw);
    if (!parsed) {
      this.options.onError?.(new Error("Received invalid gateway envelope."));
      return;
    }

    if (parsed.type === "webhook_event") {
      this.options.onWebhookEvent?.(parsed);
      return;
    }

    if (parsed.type === "control") {
      this.options.onControl?.(parsed);
      return;
    }

    if (parsed.type === "activity_result") {
      this.handleActivityResult(parsed);
    }
  }

  private handleActivityResult(envelope: GatewayActivityResultEnvelope): void {
    const pending = this.pendingActivityRequests.get(envelope.payload.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingActivityRequests.delete(envelope.payload.requestId);

    if (!envelope.payload.ok) {
      pending.reject(new Error(envelope.payload.error || "Gateway activity write failed."));
      return;
    }

    pending.resolve(envelope.payload);
  }

  private createActivityRequestId(): string {
    this.activityCounter += 1;
    return `activity:${this.config.instanceId}:${Date.now()}:${this.activityCounter}`;
  }

  private rejectPendingActivityRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingActivityRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingActivityRequests.delete(requestId);
    }
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      try {
        this.requireOpenSocket().ping();
      } catch (error) {
        this.options.onError?.(error);
      }
    }, this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (!this.pingTimer) {
      return;
    }

    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private requireOpenSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open.");
    }

    return this.socket;
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACTIVITY_RESULT_TIMEOUT_MS;
  }

  return Math.max(1_000, Math.trunc(value));
}

function normalizeRawData(data: RawData): string | null {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return data.toString("utf8");
}
