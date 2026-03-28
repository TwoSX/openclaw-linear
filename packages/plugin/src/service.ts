import type {
  OpenClawPluginService,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import type { GatewayControlEnvelope } from "./protocol.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { describeTranscriptMessages } from "./activity-stream.js";
import { registerGatewayActivityWriter, unregisterGatewayActivityWriter } from "./gateway-client-registry.js";
import { LinearGatewaySocket } from "./index.js";
import { parseChannelConfig, type ResolvedLinearChannelConfig } from "./config.js";
import { handleLinearGatewayEvent } from "./dispatch.js";
import {
  markLinearGatewayClosed,
  markLinearGatewayConnected,
  markLinearReconnectScheduled,
  markLinearServiceStarting,
  markLinearServiceStopped,
  noteLinearInbound,
  noteLinearRuntimeError,
} from "./status-store.js";

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

export function createLinearBridgeService(input: {
  logger: PluginLogger;
  runtime: PluginRuntime;
}): OpenClawPluginService {
  let socket: LinearGatewaySocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let started = false;
  let unsubscribeTranscriptTrace: (() => void) | null = null;

  return {
    id: "openclaw-linear-bridge",
    start: async (ctx) => {
      if (started) {
        return;
      }

      const parsed = parseChannelConfig(ctx.config);
      if (!parsed.enabled) {
        markLinearServiceStopped();
        noteLinearRuntimeError(null);
        input.logger.info("[openclaw-linear] service disabled by config");
        return;
      }

      if (!parsed.config) {
        markLinearServiceStopped();
        noteLinearRuntimeError(parsed.issues.join("; "));
        input.logger.warn(
          `[openclaw-linear] service not started due to config issues: ${parsed.issues.join("; ")}`,
        );
        return;
      }

      started = true;
      markLinearServiceStarting();
      installTranscriptTrace(parsed.config.debugTranscriptTrace);
      connectSocket(parsed.config);
    },
    stop: async () => {
      started = false;
      reconnectAttempt = 0;
      clearReconnectTimer();
      unsubscribeTranscriptTrace?.();
      unsubscribeTranscriptTrace = null;
      if (socket) {
        unregisterGatewayActivityWriter(socket);
      }

      socket?.disconnect();
      socket = null;
      markLinearServiceStopped();
      noteLinearRuntimeError(null);

      input.logger.info("[openclaw-linear] service stopped");
    },
  };

  function connectSocket(config: ResolvedLinearChannelConfig): void {
    if (!started) {
      return;
    }

    const nextSocket = new LinearGatewaySocket(config, {
      onOpen: () => {
        if (socket !== nextSocket) {
          return;
        }

        reconnectAttempt = 0;
        clearReconnectTimer();
        registerGatewayActivityWriter(nextSocket);
        markLinearGatewayConnected();
        input.logger.info("[openclaw-linear] connected to gateway");
      },
      onClose: (event) => {
        if (socket !== nextSocket) {
          return;
        }

        unregisterGatewayActivityWriter(nextSocket);
        socket = null;
        markLinearGatewayClosed(event);
        input.logger.warn(
          `[openclaw-linear] gateway socket closed (${event.code}) ${event.reason || "no reason"}`,
        );
        if (event.code === 4001 && event.reason === "superseded by newer client") {
          input.logger.warn(
            "[openclaw-linear] gateway closed this client as superseded; stopping automatic reconnect",
          );
          return;
        }
        scheduleReconnect(config, `close:${event.code}`);
      },
      onControl: (event) => {
        logControlEvent(input.logger, event);
      },
      onWebhookEvent: (event) => {
        noteLinearInbound();
        void Promise.resolve(
          handleLinearGatewayEvent({
            event,
            activityWriter: nextSocket,
            runtime: input.runtime,
            logger: input.logger,
            promptContextTemplate: config.promptContextTemplate,
            debugTranscriptTrace: config.debugTranscriptTrace,
          }),
        ).catch((error) => {
          input.logger.error(
            `[openclaw-linear] unhandled gateway event failure: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
      onError: (error) => {
        noteLinearRuntimeError(
          error instanceof Error ? error.message : String(error),
        );
        input.logger.error(
          `[openclaw-linear] gateway socket error: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });

    socket = nextSocket;

    try {
      nextSocket.connect();
    } catch (error) {
      if (socket === nextSocket) {
        socket = null;
      }
      input.logger.error(
        `[openclaw-linear] failed to open gateway socket: ${error instanceof Error ? error.message : String(error)}`,
      );
      scheduleReconnect(config, "connect_failure");
    }
  }

  function scheduleReconnect(
    config: ResolvedLinearChannelConfig,
    reason: string,
  ): void {
    if (!started || reconnectTimer) {
      return;
    }

    reconnectAttempt += 1;
    const delayMs = calculateReconnectDelayMs(reconnectAttempt);

    input.logger.warn(
      `[openclaw-linear] scheduling reconnect attempt ${reconnectAttempt} in ${delayMs}ms (${reason})`,
    );
    markLinearReconnectScheduled(reconnectAttempt);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!started) {
        return;
      }
      connectSocket(config);
    }, delayMs);
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function calculateReconnectDelayMs(attempt: number): number {
    const exponentialDelay =
      DEFAULT_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
    return Math.min(exponentialDelay, DEFAULT_RECONNECT_MAX_DELAY_MS);
  }

  function installTranscriptTrace(enabled: boolean | undefined): void {
    unsubscribeTranscriptTrace?.();
    unsubscribeTranscriptTrace = null;

    if (!enabled) {
      return;
    }

    unsubscribeTranscriptTrace = input.runtime.events.onSessionTranscriptUpdate((update) => {
      if (!update.sessionKey?.startsWith("linear:")) {
        return;
      }

      input.logger.info(
        `[openclaw-linear][trace] transcript:update ${JSON.stringify({
          sessionKey: update.sessionKey,
          messageId: update.messageId ?? null,
          message: describeTranscriptMessages(
            update.message === undefined ? [] : [update.message],
          )[0] ?? null,
        })}`,
      );
    });
  }
}

function logControlEvent(logger: PluginLogger, event: GatewayControlEnvelope): void {
  const message =
    `[openclaw-linear] control action=${event.payload.action} instance=${event.payload.instanceId ?? "unknown"} detail=${String(event.payload.detail ?? "")}`;

  if (event.payload.action === "auth_fail") {
    logger.warn(message);
    return;
  }

  logger.debug?.(message);
}
