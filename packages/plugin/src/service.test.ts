import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROMPT_CONTEXT_TEMPLATE } from "./config.js";

const socketInstances: Array<{
  config: Record<string, unknown>;
  options: Record<string, unknown>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

const registerGatewayActivityWriter = vi.fn();
const unregisterGatewayActivityWriter = vi.fn();
const handleLinearGatewayEvent = vi.fn();

const LinearGatewaySocket = vi.fn(function MockLinearGatewaySocket(
  config: Record<string, unknown>,
  options: Record<string, unknown>,
) {
  const instance = {
    config,
    options,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  socketInstances.push(instance);
  return instance;
});

vi.mock("./index.js", () => ({
  LinearGatewaySocket,
}));

vi.mock("./gateway-client-registry.js", () => ({
  registerGatewayActivityWriter,
  unregisterGatewayActivityWriter,
}));

vi.mock("./dispatch.js", () => ({
  handleLinearGatewayEvent,
}));

const { createLinearBridgeService } = await import("./service.js");
const {
  readLinearRuntimeStatus,
  resetLinearRuntimeStatus,
} = await import("./status-store.js");

const validConfig = {
  channels: {
    linear: {
      enabled: true,
      gatewayBaseUrl: "https://worker.example.com",
      clientAuthToken: "client-token",
    },
  },
};

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("createLinearBridgeService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socketInstances.length = 0;
    LinearGatewaySocket.mockClear();
    registerGatewayActivityWriter.mockReset();
    unregisterGatewayActivityWriter.mockReset();
    handleLinearGatewayEvent.mockReset();
    resetLinearRuntimeStatus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects after the gateway socket closes unexpectedly", async () => {
    const logger = createLogger();
    const service = createLinearBridgeService({
      logger,
      runtime: {} as never,
    });

    await service.start({
      config: validConfig,
      stateDir: "/tmp/openclaw-linear",
      logger,
    } as never);

    expect(socketInstances).toHaveLength(1);
    expect(socketInstances[0]?.connect).toHaveBeenCalledTimes(1);

    const firstOpen = socketInstances[0]?.options.onOpen as (() => void) | undefined;
    firstOpen?.();
    expect(registerGatewayActivityWriter).toHaveBeenCalledWith(socketInstances[0]);

    const firstClose = socketInstances[0]?.options.onClose as
      | ((event: { code: number; reason: string }) => void)
      | undefined;
    firstClose?.({ code: 1006, reason: "network lost" });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(unregisterGatewayActivityWriter).toHaveBeenCalledWith(socketInstances[0]);
    expect(socketInstances).toHaveLength(2);
    expect(socketInstances[1]?.connect).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("scheduling reconnect attempt 1 in 1000ms"),
    );
  });

  it("stops automatic reconnect when the client is superseded", async () => {
    const logger = createLogger();
    const service = createLinearBridgeService({
      logger,
      runtime: {} as never,
    });

    await service.start({
      config: validConfig,
      stateDir: "/tmp/openclaw-linear",
      logger,
    } as never);

    const firstClose = socketInstances[0]?.options.onClose as
      | ((event: { code: number; reason: string }) => void)
      | undefined;
    firstClose?.({ code: 4001, reason: "superseded by newer client" });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(socketInstances).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("stopping automatic reconnect"),
    );
  });

  it("forwards webhook events through the connected gateway socket writer", async () => {
    const logger = createLogger();
    const runtime = {} as never;
    const service = createLinearBridgeService({
      logger,
      runtime,
    });

    await service.start({
      config: validConfig,
      stateDir: "/tmp/openclaw-linear",
      logger,
    } as never);

    const onWebhookEvent = socketInstances[0]?.options.onWebhookEvent as
      | ((event: unknown) => void)
      | undefined;

    const event = {
      type: "webhook_event",
      eventId: "evt-1",
      timestamp: "2026-03-26T10:00:00.000Z",
      payload: {
        organizationId: "org-1",
        eventType: "created",
        agentSessionId: "session-1",
        raw: {},
      },
    };

    onWebhookEvent?.(event);

    expect(handleLinearGatewayEvent).toHaveBeenCalledWith({
      event,
      activityWriter: socketInstances[0],
      runtime,
      logger,
      debugTranscriptTrace: false,
      promptContextTemplate: DEFAULT_PROMPT_CONTEXT_TEMPLATE,
    });
  });

  it("logs auth_fail control events as warnings", async () => {
    const logger = createLogger();
    const service = createLinearBridgeService({
      logger,
      runtime: {} as never,
    });

    await service.start({
      config: validConfig,
      stateDir: "/tmp/openclaw-linear",
      logger,
    } as never);

    const onControl = socketInstances[0]?.options.onControl as
      | ((event: { payload: { action: string; instanceId?: string; detail?: string } }) => void)
      | undefined;

    onControl?.({
      payload: {
        action: "auth_fail",
        instanceId: "inst-1",
        detail: "invalid envelope payload",
      },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("control action=auth_fail"),
    );
  });

  it("updates runtime status when the socket lifecycle changes", async () => {
    const logger = createLogger();
    const service = createLinearBridgeService({
      logger,
      runtime: {} as never,
    });

    await service.start({
      config: validConfig,
      stateDir: "/tmp/openclaw-linear",
      logger,
    } as never);

    expect(readLinearRuntimeStatus().running).toBe(true);
    expect(readLinearRuntimeStatus().connected).toBe(false);

    const onOpen = socketInstances[0]?.options.onOpen as (() => void) | undefined;
    onOpen?.();

    expect(readLinearRuntimeStatus().connected).toBe(true);
    expect(readLinearRuntimeStatus().lastConnectedAt).not.toBeNull();

    const onWebhookEvent = socketInstances[0]?.options.onWebhookEvent as
      | ((event: unknown) => void)
      | undefined;
    onWebhookEvent?.({
      type: "webhook_event",
      eventId: "evt-health",
      timestamp: "2026-03-27T04:50:43.841Z",
      payload: {
        organizationId: "org-1",
        eventType: "prompted",
        agentSessionId: "session-1",
        raw: {},
      },
    });

    expect(readLinearRuntimeStatus().lastInboundAt).not.toBeNull();

    const onClose = socketInstances[0]?.options.onClose as
      | ((event: { code: number; reason: string }) => void)
      | undefined;
    onClose?.({ code: 1006, reason: "network lost" });

    expect(readLinearRuntimeStatus().connected).toBe(false);
    expect(readLinearRuntimeStatus().reconnectAttempts).toBe(1);
  });
});
