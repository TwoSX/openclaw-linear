import { describe, expect, it } from "vitest";
import { installCommonResolveTargetErrorCases } from "openclaw/plugin-sdk/testing";
import { linearChannelPlugin, resolveLinearChannelAccount } from "./channel.js";
import { DEFAULT_PROMPT_CONTEXT_TEMPLATE } from "./config.js";
import {
  noteLinearInbound,
  noteLinearRuntimeError,
  patchLinearRuntimeStatusForTests,
  resetLinearRuntimeStatus,
} from "./status-store.js";

type ResolveTargetFn = NonNullable<NonNullable<typeof linearChannelPlugin.outbound>["resolveTarget"]>;

const resolveTarget = linearChannelPlugin.outbound?.resolveTarget as ResolveTargetFn | undefined;
const normalizeTarget = linearChannelPlugin.messaging?.normalizeTarget;

if (!resolveTarget) {
  throw new Error("Expected linear channel outbound.resolveTarget to be defined.");
}

if (!normalizeTarget) {
  throw new Error("Expected linear channel messaging.normalizeTarget to be defined.");
}

installCommonResolveTargetErrorCasesCompat({
  resolveTarget,
  implicitAllowFrom: ["session:allowed-session"],
});

describe("linearChannelPlugin", () => {
  describe("target resolution", () => {
    it("normalizes session targets", () => {
      const result = resolveTarget({
        to: " session:abc-123 ",
        mode: "explicit",
        allowFrom: [],
      });

      expect(result).toEqual({
        ok: true,
        to: "session:abc-123",
      });
    });

    it("accepts raw agent session ids and normalizes them into session targets", () => {
      const result = resolveTarget({
        to: "abc-123",
        mode: "explicit",
        allowFrom: [],
      });

      expect(result).toEqual({
        ok: true,
        to: "session:abc-123",
      });
    });

    it("normalizes raw messaging targets through the public channel adapter", () => {
      expect(normalizeTarget(" session:abc-123 ")).toBe("session:abc-123");
      expect(normalizeTarget("abc-123")).toBe("session:abc-123");
      expect(normalizeTarget("   ")).toBeUndefined();
    });
  });

  describe("account resolution", () => {
    it("describes a configured default account from channels.linear", () => {
      const account = resolveLinearChannelAccount({
        channels: {
          linear: {
            enabled: true,
            gatewayBaseUrl: "https://worker.example.com",
            clientAuthToken: "client-token",
          },
        },
      });

      expect(account).toEqual({
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          gatewayBaseUrl: "https://worker.example.com",
          clientAuthToken: "client-token",
          debugTranscriptTrace: false,
          promptContextTemplate: DEFAULT_PROMPT_CONTEXT_TEMPLATE,
        },
      });
    });

    it("marks the account as unconfigured when required fields are missing", () => {
      const account = resolveLinearChannelAccount({
        channels: {
          linear: {
            enabled: true,
          },
        },
      });

      expect(account.accountId).toBe("default");
      expect(account.enabled).toBe(true);
      expect(account.configured).toBe(false);
      expect(account.config).toBeNull();
    });
  });

  describe("status snapshots", () => {
    it("exposes runtime channel status for the default account", async () => {
      resetLinearRuntimeStatus();
      patchLinearRuntimeStatusForTests({
        running: true,
        connected: true,
      });
      noteLinearInbound(1_700_000_000_000);
      noteLinearRuntimeError("temporary disconnect");

      const account = resolveLinearChannelAccount({
        channels: {
          linear: {
            enabled: true,
            gatewayBaseUrl: "https://worker.example.com",
            clientAuthToken: "client-token",
          },
        },
      });

      const snapshot = await linearChannelPlugin.status?.buildAccountSnapshot?.({
        account,
        cfg: {
          channels: {
            linear: {
              enabled: true,
              gatewayBaseUrl: "https://worker.example.com",
              clientAuthToken: "client-token",
            },
          },
        } as never,
      });

      expect(snapshot).toMatchObject({
        accountId: "default",
        configured: true,
        enabled: true,
        running: true,
        connected: true,
        lastInboundAt: 1_700_000_000_000,
        lastError: "temporary disconnect",
      });
    });
  });
});

function installCommonResolveTargetErrorCasesCompat(params: {
  resolveTarget: ResolveTargetFn;
  implicitAllowFrom: string[];
}): void {
  try {
    installCommonResolveTargetErrorCases(params);
  } catch (error) {
    if (isOpenClawVitestInteropError(error)) {
      installFallbackResolveTargetErrorCases(params);
      return;
    }

    throw error;
  }
}

function installFallbackResolveTargetErrorCases(params: {
  resolveTarget: ResolveTargetFn;
  implicitAllowFrom: string[];
}): void {
  it("should error on normalization failure with allowlist (implicit mode)", () => {
    const result = params.resolveTarget({
      to: "invalid-target",
      mode: "implicit",
      allowFrom: params.implicitAllowFrom,
    });
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeDefined();
  });

  it("should error when no target provided with allowlist", () => {
    const result = params.resolveTarget({
      to: undefined,
      mode: "implicit",
      allowFrom: params.implicitAllowFrom,
    });
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeDefined();
  });

  it("should error when no target and no allowlist", () => {
    const result = params.resolveTarget({
      to: undefined,
      mode: "explicit",
      allowFrom: [],
    });
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeDefined();
  });

  it("should handle whitespace-only target", () => {
    const result = params.resolveTarget({
      to: "   ",
      mode: "explicit",
      allowFrom: [],
    });
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeDefined();
  });
}

function isOpenClawVitestInteropError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Vitest failed to find the current suite")
  );
}
