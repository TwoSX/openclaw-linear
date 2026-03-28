import { createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/status-helpers";

const DEFAULT_ACCOUNT_ID = "default";

type LinearRuntimeStatus = {
  accountId: string;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  connected: boolean;
  lastConnectedAt: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  reconnectAttempts: number;
};

const DEFAULT_RUNTIME_STATUS: LinearRuntimeStatus = {
  ...(createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
    connected: false,
    lastConnectedAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    reconnectAttempts: 0,
  }) as LinearRuntimeStatus),
};

let runtimeStatus: LinearRuntimeStatus = cloneStatus(DEFAULT_RUNTIME_STATUS);

export function getDefaultLinearRuntimeStatus(): LinearRuntimeStatus {
  return cloneStatus(DEFAULT_RUNTIME_STATUS);
}

export function readLinearRuntimeStatus(accountId = DEFAULT_ACCOUNT_ID): LinearRuntimeStatus {
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return {
      ...getDefaultLinearRuntimeStatus(),
      accountId,
    };
  }

  return cloneStatus(runtimeStatus);
}

export function resetLinearRuntimeStatus(): void {
  runtimeStatus = cloneStatus(DEFAULT_RUNTIME_STATUS);
}

export function markLinearServiceStarting(): void {
  patchLinearRuntimeStatus({
    running: true,
    lastStartAt: Date.now(),
    lastError: null,
  });
}

export function markLinearServiceStopped(): void {
  patchLinearRuntimeStatus({
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastStopAt: Date.now(),
  });
}

export function markLinearGatewayConnected(): void {
  patchLinearRuntimeStatus({
    running: true,
    connected: true,
    reconnectAttempts: 0,
    lastConnectedAt: Date.now(),
    lastError: null,
  });
}

export function markLinearGatewayClosed(input: {
  code: number;
  reason: string;
}): void {
  patchLinearRuntimeStatus({
    connected: false,
    lastError:
      input.code === 1000
        ? null
        : `Gateway socket closed (${input.code}) ${input.reason || "no reason"}`,
  });
}

export function markLinearReconnectScheduled(attempt: number): void {
  patchLinearRuntimeStatus({
    running: true,
    connected: false,
    reconnectAttempts: attempt,
  });
}

export function noteLinearInbound(at = Date.now()): void {
  patchLinearRuntimeStatus({
    lastInboundAt: at,
  });
}

export function noteLinearOutbound(at = Date.now()): void {
  patchLinearRuntimeStatus({
    lastOutboundAt: at,
  });
}

export function noteLinearRuntimeError(message: string | null): void {
  patchLinearRuntimeStatus({
    lastError: message,
  });
}

export function patchLinearRuntimeStatusForTests(
  patch: Partial<LinearRuntimeStatus>,
): void {
  patchLinearRuntimeStatus(patch);
}

function patchLinearRuntimeStatus(patch: Partial<LinearRuntimeStatus>): void {
  runtimeStatus = {
    ...runtimeStatus,
    ...patch,
    accountId: DEFAULT_ACCOUNT_ID,
  };
}

function cloneStatus(snapshot: LinearRuntimeStatus): LinearRuntimeStatus {
  return {
    ...snapshot,
  };
}
