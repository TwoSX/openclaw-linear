import { DurableObject } from "cloudflare:workers";
import {
  createAgentActivity,
  refreshAccessToken,
  shouldRefreshToken,
  type LinearTokenBundle,
  type LinearViewerSnapshot,
} from "./linear-api.js";
import {
  DEFAULT_BUFFER_MAX_AGE_MS,
  DEFAULT_BUFFER_MAX_ITEMS,
  type GatewayActivityRequestEnvelope,
  type GatewayActivityResultEnvelope,
  type GatewayControlEnvelope,
  type GatewayWebhookEnvelope,
  parseEnvelope,
  pruneBufferedEvents,
  serializeEnvelope,
} from "../../../shared/protocol.js";
import type { Env } from "./index.js";
import { hasMatchingClientAuthToken, resolvePresentedClientAuthToken } from "./client-auth.js";

const INSTALLATION_KEY = "linear:installation";
const TRANSIENT_STATE_KEY = "linear:transient-state";
const TOKEN_REFRESH_BUFFER_SECONDS = 60 * 60;
const CLOSE_CODE_SUPERSEDED = 4001;
const CLOSE_CODE_WORKSPACE_CHANGED = 4002;
const BRIDGE_NAME = "openclaw-linear";

interface ClientAttachment {
  instanceId: string;
  connectedAt: number;
  ready: boolean;
}

interface InstallationState extends LinearTokenBundle, LinearViewerSnapshot {
  updatedAt: string;
}

interface TransientState {
  buffer: GatewayWebhookEnvelope[];
  seenEventIds: Array<[string, number]>;
}

interface ClientConnection {
  socket: WebSocket;
  attachment: ClientAttachment;
}

export interface AcceptWebhookEventResult {
  ignored: boolean;
  duplicate: boolean;
  buffered: boolean;
  delivered: boolean;
  clientConnected: boolean;
  clientReady: boolean;
  bufferDepth: number;
  installationConfigured: boolean;
}

export type StoreOAuthStateInput = LinearTokenBundle & LinearViewerSnapshot;

export interface ResolveMcpProxyAccessTokenResult {
  accessToken: string;
  organizationId: string;
  organizationName: string;
}

export class LinearBridgeDurableObject extends DurableObject<Env> {
  private installationCache: InstallationState | null | undefined = undefined;
  private transientLoaded = false;
  private buffer: GatewayWebhookEnvelope[] = [];
  private readonly seenEventIds = new Map<string, number>();

  async storeOAuthState(input: StoreOAuthStateInput): Promise<{
    ok: true;
    organizationId: string;
    organizationName: string;
  }> {
    const nextState: InstallationState = {
      ...input,
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put(INSTALLATION_KEY, nextState);
    await this.resetTransientState();
    this.installationCache = nextState;
    await this.closeAllClients(CLOSE_CODE_WORKSPACE_CHANGED, "workspace changed");

    this.logInfo("Stored active Linear installation state.", {
      organizationId: nextState.organizationId,
      organizationName: nextState.organizationName,
      viewerId: nextState.viewerId,
    });

    return {
      ok: true,
      organizationId: nextState.organizationId,
      organizationName: nextState.organizationName,
    };
  }

  async acceptWebhookEvent(envelope: GatewayWebhookEnvelope): Promise<AcceptWebhookEventResult> {
    await this.loadTransientState();
    await this.pruneTransientState();

    const installation = await this.getInstallationState();
    if (!installation) {
      this.logWarn("Ignoring webhook because no active installation is configured.", {
        eventId: envelope.eventId,
        eventType: envelope.payload.eventType,
      });
      return this.buildWebhookResult({
        ignored: true,
        installationConfigured: false,
      });
    }

    if (envelope.payload.organizationId !== installation.organizationId) {
      this.logWarn("Ignoring webhook for non-active organization.", {
        eventId: envelope.eventId,
        eventType: envelope.payload.eventType,
        organizationId: envelope.payload.organizationId ?? "unknown",
        activeOrganizationId: installation.organizationId,
      });
      return this.buildWebhookResult({
        ignored: true,
      });
    }

    if (this.seenEventIds.has(envelope.eventId)) {
      this.logInfo("Dropped duplicate webhook event.", {
        eventId: envelope.eventId,
        organizationId: installation.organizationId,
      });
      return this.buildWebhookResult({
        duplicate: true,
      });
    }

    this.seenEventIds.set(envelope.eventId, Date.now());

    const client = this.getActiveClient();
    if (!client || !client.attachment.ready) {
      await this.bufferWebhookEvent(envelope);

      this.logInfo("Buffered webhook event while client was unavailable.", {
        eventId: envelope.eventId,
        organizationId: installation.organizationId,
        bufferDepth: this.buffer.length,
        clientConnected: Boolean(client),
      });

      return this.buildWebhookResult({
        buffered: true,
        clientConnected: Boolean(client),
        clientReady: Boolean(client?.attachment.ready),
      });
    }

    const delivered = this.safeSend(client.socket, serializeEnvelope(envelope), {
      context: "webhook delivery",
      eventId: envelope.eventId,
      instanceId: client.attachment.instanceId,
    });

    if (!delivered) {
      await this.bufferWebhookEvent(envelope);

      this.logWarn("Re-buffered webhook event after direct delivery failed.", {
        eventId: envelope.eventId,
        organizationId: installation.organizationId,
        instanceId: client.attachment.instanceId,
        bufferDepth: this.buffer.length,
      });

      return this.buildWebhookResult({
        buffered: true,
        clientConnected: Boolean(this.getActiveClient()),
        clientReady: Boolean(this.getActiveClient()?.attachment.ready),
      });
    }

    this.logInfo("Delivered webhook event to active client.", {
      eventId: envelope.eventId,
      organizationId: installation.organizationId,
      instanceId: client.attachment.instanceId,
    });

    return this.buildWebhookResult({
      delivered: true,
      clientConnected: true,
      clientReady: true,
    });
  }

  private async bufferWebhookEvent(envelope: GatewayWebhookEnvelope): Promise<void> {
    this.buffer = pruneBufferedEvents([...this.buffer, envelope], {
      maxItems: DEFAULT_BUFFER_MAX_ITEMS,
      maxAgeMs: DEFAULT_BUFFER_MAX_AGE_MS,
    });
    await this.persistTransientState();
  }

  async statusSnapshot(): Promise<{
    organizationId: string | null;
    organizationName: string | null;
    clientConnected: boolean;
    clientReady: boolean;
    clientInstanceId: string | null;
    bufferDepth: number;
  }> {
    await this.loadTransientState();
    await this.pruneTransientState();

    const installation = await this.getInstallationState();
    const client = this.getActiveClient();

    return {
      organizationId: installation?.organizationId ?? null,
      organizationName: installation?.organizationName ?? null,
      clientConnected: Boolean(client),
      clientReady: Boolean(client?.attachment.ready),
      clientInstanceId: client?.attachment.instanceId ?? null,
      bufferDepth: this.buffer.length,
    };
  }

  async resolveMcpProxyAccessToken(): Promise<ResolveMcpProxyAccessTokenResult> {
    const installation = await this.getRefreshedInstallationState();

    return {
      accessToken: installation.accessToken,
      organizationId: installation.organizationId,
      organizationName: installation.organizationName,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not Found", { status: 404 });
    }

    return await this.handleWebSocketUpgrade(request);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }

    const parsed = parseEnvelope(message);
    if (!parsed) {
      const instanceId = this.readAttachment(ws)?.instanceId ?? "unknown";
      this.logWarn("Received invalid socket envelope.", {
        instanceId,
      });
      this.sendControl(ws, "auth_fail", instanceId, "invalid envelope payload");
      return;
    }

    if (parsed.type === "control") {
      await this.handleControlMessage(ws, parsed);
      return;
    }

    if (parsed.type === "activity_request") {
      await this.handleActivityRequest(ws, parsed);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = this.readAttachment(ws);
    if (!attachment) {
      return;
    }

    this.logInfo("Client socket closed.", {
      instanceId: attachment.instanceId,
      code,
      reason,
      clientConnected: Boolean(this.getActiveClient()),
    });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const installation = await this.getInstallationState();
    if (!installation) {
      return new Response("No active Linear workspace is configured. Complete OAuth first.", {
        status: 409,
      });
    }

    const url = new URL(request.url);
    const providedToken = resolvePresentedClientAuthToken(request, {
      searchParams: url.searchParams,
      allowQueryParam: true,
    });

    if (!hasMatchingClientAuthToken(providedToken, this.env.CLIENT_AUTH_TOKEN)) {
      this.logWarn("Rejected WebSocket upgrade with invalid client auth token.", {
        instanceId: url.searchParams.get("instanceId") ?? "unknown",
      });
      return new Response("Unauthorized", { status: 401 });
    }

    const instanceId = url.searchParams.get("instanceId");
    if (!instanceId) {
      return new Response("Missing instanceId", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    this.writeAttachment(server, {
      instanceId,
      connectedAt: Date.now(),
      ready: false,
    });

    await this.closeOlderClients(server);

    this.logInfo("Accepted active client websocket.", {
      instanceId,
      organizationId: installation.organizationId,
    });

    this.sendControl(server, "connected", instanceId, "connection accepted");

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleControlMessage(
    ws: WebSocket,
    control: GatewayControlEnvelope,
  ): Promise<void> {
    if (control.payload.action !== "ready") {
      return;
    }

    const client = this.getCurrentClientForSocket(ws, "control");
    if (!client) {
      return;
    }

    if (!client.attachment.ready) {
      client.attachment.ready = true;
      this.writeAttachment(client.socket, client.attachment);
      this.logInfo("Client reported ready.", {
        instanceId: client.attachment.instanceId,
      });
    }

    await this.flushBufferedEvents();
  }

  private async handleActivityRequest(
    ws: WebSocket,
    envelope: GatewayActivityRequestEnvelope,
  ): Promise<void> {
    const client = this.getCurrentClientForSocket(ws, "activity_request");
    if (!client) {
      return;
    }

    try {
      const result = await this.writeGatewayActivity(envelope);
      this.sendActivityResult(ws, {
        requestId: envelope.payload.requestId,
        agentSessionId: envelope.payload.agentSessionId,
        ok: true,
        agentActivityId: result.agentActivityId || null,
      });

      this.logInfo("Wrote Linear activity through active installation.", {
        requestId: envelope.payload.requestId,
        agentSessionId: envelope.payload.agentSessionId,
        instanceId: client.attachment.instanceId,
        activityType: envelope.payload.content.type,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.sendActivityResult(ws, {
        requestId: envelope.payload.requestId,
        agentSessionId: envelope.payload.agentSessionId,
        ok: false,
        error: message,
      });

      this.logError("Failed to write Linear activity.", {
        requestId: envelope.payload.requestId,
        agentSessionId: envelope.payload.agentSessionId,
        instanceId: client.attachment.instanceId,
        error: message,
      });
    }
  }

  private async writeGatewayActivity(envelope: GatewayActivityRequestEnvelope) {
    const installation = await this.getRefreshedInstallationState();
    return await createAgentActivity({
      accessToken: installation.accessToken,
      agentSessionId: envelope.payload.agentSessionId,
      clientGeneratedId: envelope.payload.clientGeneratedId,
      content: envelope.payload.content,
    });
  }

  private async flushBufferedEvents(): Promise<void> {
    await this.loadTransientState();

    const client = this.getActiveClient();
    if (!client || !client.attachment.ready || this.buffer.length === 0) {
      return;
    }

    const pending = [...this.buffer];
    let sentCount = 0;

    for (const envelope of pending) {
      const delivered = this.safeSend(client.socket, serializeEnvelope(envelope), {
        context: "buffer replay",
        eventId: envelope.eventId,
        instanceId: client.attachment.instanceId,
      });

      if (!delivered) {
        break;
      }

      sentCount += 1;
    }

    this.buffer = pending.slice(sentCount);
    await this.persistTransientState();

    if (sentCount > 0) {
      this.logInfo("Flushed buffered webhook events to client.", {
        instanceId: client.attachment.instanceId,
        deliveredCount: sentCount,
      });
    }

    if (this.buffer.length > 0) {
      this.logWarn(
        "Stopped buffer replay after socket send failure; kept remaining events buffered.",
        {
          instanceId: client.attachment.instanceId,
          remainingCount: this.buffer.length,
        },
      );
    }
  }

  private async getRefreshedInstallationState(): Promise<InstallationState> {
    const installation = await this.getInstallationState();
    if (!installation) {
      throw new Error("Linear installation is not configured.");
    }

    if (!shouldRefreshToken(installation.expiresAt, TOKEN_REFRESH_BUFFER_SECONDS)) {
      return installation;
    }

    const refreshed = await refreshAccessToken({
      clientId: this.env.LINEAR_CLIENT_ID,
      clientSecret: this.env.LINEAR_CLIENT_SECRET,
      refreshToken: installation.refreshToken,
    });

    const nextInstallation: InstallationState = {
      ...installation,
      ...refreshed,
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put(INSTALLATION_KEY, nextInstallation);
    this.installationCache = nextInstallation;

    this.logInfo("Refreshed Linear installation token bundle.", {
      organizationId: nextInstallation.organizationId,
      viewerId: nextInstallation.viewerId,
    });

    return nextInstallation;
  }

  private async getInstallationState(): Promise<InstallationState | null> {
    if (this.installationCache !== undefined) {
      return this.installationCache;
    }

    this.installationCache =
      (await this.ctx.storage.get<InstallationState>(INSTALLATION_KEY)) ?? null;
    return this.installationCache;
  }

  private async loadTransientState(): Promise<void> {
    if (this.transientLoaded) {
      return;
    }

    const state = await this.ctx.storage.get<TransientState>(TRANSIENT_STATE_KEY);
    this.buffer = state?.buffer ?? [];
    this.seenEventIds.clear();
    for (const [eventId, seenAt] of state?.seenEventIds ?? []) {
      this.seenEventIds.set(eventId, seenAt);
    }
    this.transientLoaded = true;
  }

  private async pruneTransientState(): Promise<void> {
    let changed = false;
    const now = Date.now();

    for (const [eventId, seenAt] of this.seenEventIds.entries()) {
      if (now - seenAt > DEFAULT_BUFFER_MAX_AGE_MS * 2) {
        this.seenEventIds.delete(eventId);
        changed = true;
      }
    }

    const nextBuffer = pruneBufferedEvents(this.buffer, {
      maxItems: DEFAULT_BUFFER_MAX_ITEMS,
      maxAgeMs: DEFAULT_BUFFER_MAX_AGE_MS,
    });

    if (nextBuffer.length !== this.buffer.length) {
      this.buffer = nextBuffer;
      changed = true;
    }

    if (changed) {
      await this.persistTransientState();
    }
  }

  private async resetTransientState(): Promise<void> {
    this.transientLoaded = true;
    this.buffer = [];
    this.seenEventIds.clear();
    await this.persistTransientState();
  }

  private async persistTransientState(): Promise<void> {
    await this.ctx.storage.put(TRANSIENT_STATE_KEY, {
      buffer: this.buffer,
      seenEventIds: [...this.seenEventIds.entries()],
    } satisfies TransientState);
  }

  private getActiveClient(): ClientConnection | null {
    const clients = this.listClients();
    return clients.sort(
      (left, right) => right.attachment.connectedAt - left.attachment.connectedAt,
    )[0] ?? null;
  }

  private listClients(): ClientConnection[] {
    return this.ctx
      .getWebSockets()
      .map((socket) => {
        const attachment = this.readAttachment(socket);
        if (!attachment) {
          return null;
        }

        return { socket, attachment };
      })
      .filter((client): client is ClientConnection => Boolean(client));
  }

  private getCurrentClientForSocket(
    socket: WebSocket,
    context: "control" | "activity_request",
  ): ClientConnection | null {
    const activeClient = this.getActiveClient();
    if (!activeClient) {
      return null;
    }

    if (activeClient.socket === socket) {
      return activeClient;
    }

    const attachment = this.readAttachment(socket);
    this.logWarn("Ignoring socket message from superseded client.", {
      context,
      instanceId: attachment?.instanceId ?? "unknown",
      activeInstanceId: activeClient.attachment.instanceId,
    });
    return null;
  }

  private async closeOlderClients(currentSocket: WebSocket): Promise<void> {
    for (const client of this.listClients()) {
      if (client.socket === currentSocket) {
        continue;
      }

      try {
        client.socket.close(CLOSE_CODE_SUPERSEDED, "superseded by newer client");
      } catch {
        // Ignore close failures for already-closing sockets.
      }
    }
  }

  private readAttachment(socket: WebSocket): ClientAttachment | null {
    const raw = socket.deserializeAttachment();
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const candidate = raw as Partial<ClientAttachment>;
    if (
      typeof candidate.instanceId !== "string" ||
      typeof candidate.connectedAt !== "number" ||
      typeof candidate.ready !== "boolean"
    ) {
      return null;
    }

    return candidate as ClientAttachment;
  }

  private writeAttachment(socket: WebSocket, attachment: ClientAttachment): void {
    socket.serializeAttachment(attachment);
  }

  private sendControl(
    socket: WebSocket,
    action: GatewayControlEnvelope["payload"]["action"],
    instanceId: string,
    detail?: string,
  ): void {
    const envelope: GatewayControlEnvelope = {
      type: "control",
      eventId: `ctrl:${instanceId}:${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: {
        action,
        instanceId,
        detail,
      },
    };

    this.safeSend(socket, serializeEnvelope(envelope), {
      context: "control",
      instanceId,
      action,
    });
  }

  private sendActivityResult(
    socket: WebSocket,
    params: {
      requestId: string;
      agentSessionId: string;
      ok: boolean;
      agentActivityId?: string | null;
      error?: string;
    },
  ): void {
    const envelope: GatewayActivityResultEnvelope = {
      type: "activity_result",
      eventId: `activity-result:${params.requestId}:${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: {
        requestId: params.requestId,
        ok: params.ok,
        agentSessionId: params.agentSessionId,
        agentActivityId: params.agentActivityId,
        error: params.error,
      },
    };

    this.safeSend(socket, serializeEnvelope(envelope), {
      context: "activity result",
      requestId: params.requestId,
      ok: params.ok,
    });
  }

  private buildWebhookResult(
    overrides: Partial<AcceptWebhookEventResult>,
  ): AcceptWebhookEventResult {
    const client = this.getActiveClient();

    return {
      ignored: false,
      duplicate: false,
      buffered: false,
      delivered: false,
      clientConnected: Boolean(client),
      clientReady: Boolean(client?.attachment.ready),
      bufferDepth: this.buffer.length,
      installationConfigured: true,
      ...overrides,
    };
  }

  private safeSend(socket: WebSocket, payload: string, meta: Record<string, unknown>): boolean {
    try {
      socket.send(payload);
      return true;
    } catch (error) {
      this.logWarn("Failed to send WebSocket payload.", {
        ...meta,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async closeAllClients(code: number, reason: string): Promise<void> {
    for (const client of this.listClients()) {
      try {
        client.socket.close(code, reason);
      } catch {
        // Ignore close failures for already-closing sockets.
      }
    }
  }

  private logInfo(message: string, meta: Record<string, unknown>): void {
    console.info(this.formatLog(message, meta));
  }

  private logWarn(message: string, meta: Record<string, unknown>): void {
    console.warn(this.formatLog(message, meta));
  }

  private logError(message: string, meta: Record<string, unknown>): void {
    console.error(this.formatLog(message, meta));
  }

  private formatLog(message: string, meta: Record<string, unknown>): string {
    const details = Object.entries({
      bridge: BRIDGE_NAME,
      ...meta,
    })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${this.formatLogValue(value)}`)
      .join(" ");

    return details
      ? `[openclaw-linear/bridge-do] ${message} ${details}`
      : `[openclaw-linear/bridge-do] ${message}`;
  }

  private formatLogValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    return JSON.stringify(value);
  }
}
