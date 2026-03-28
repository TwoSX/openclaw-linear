import {
  buildChannelConfigSchema,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/core";
import type { ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildComputedAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { z } from "zod";
import type { GatewayAgentActivityContent } from "./protocol.js";
import type { OpenClawLinearPluginConfig } from "./index.js";
import { parseChannelConfig } from "./config.js";
import { getGatewayActivityWriter } from "./gateway-client-registry.js";
import { linearSetupAdapter, linearSetupWizard } from "./setup.js";
import { readLinearRuntimeStatus } from "./status-store.js";

const LinearChannelConfigSchema = z.object({
  enabled: z.boolean().optional(),
  gatewayBaseUrl: z.string().optional(),
  clientAuthToken: z.string().optional(),
  promptContextTemplate: z.string().optional(),
  debugTranscriptTrace: z.boolean().optional(),
  healthMonitor: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
});

export interface ResolvedLinearChannelAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  config: OpenClawLinearPluginConfig | null;
}

const linearConfigAdapter = createTopLevelChannelConfigAdapter<ResolvedLinearChannelAccount>({
  sectionKey: "linear",
  resolveAccount: (cfg) => resolveLinearChannelAccount(cfg),
  resolveAllowFrom: () => [],
  formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
});

const linearStatusAdapter = {
  defaultRuntime: createDefaultChannelRuntimeState("default", {
    connected: false,
    lastConnectedAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    reconnectAttempts: 0,
  }),
  buildAccountSnapshot: ({
    account,
  }: {
    account: ResolvedLinearChannelAccount;
    cfg: OpenClawConfig;
    runtime?: ChannelAccountSnapshot;
    probe?: unknown;
    audit?: unknown;
  }) => {
    const runtime = readLinearRuntimeStatus(account.accountId);
    return buildComputedAccountStatusSnapshot(
      {
        accountId: account.accountId,
        name: account.config?.gatewayBaseUrl,
        enabled: account.enabled,
        configured: account.configured,
        runtime,
      },
      {
        connected: runtime.connected ?? false,
        lastConnectedAt: runtime.lastConnectedAt ?? null,
        reconnectAttempts: runtime.reconnectAttempts ?? 0,
      },
    );
  },
  buildChannelSummary: ({
    snapshot,
  }: {
    account: ResolvedLinearChannelAccount;
    cfg: OpenClawConfig;
    defaultAccountId: string;
    snapshot: ChannelAccountSnapshot;
  }) => ({
    configured: snapshot.configured ?? false,
    running: snapshot.running ?? false,
    connected: snapshot.connected ?? false,
    lastInboundAt: snapshot.lastInboundAt ?? null,
    lastConnectedAt: snapshot.lastConnectedAt ?? null,
    lastError: snapshot.lastError ?? null,
  }),
  collectStatusIssues: (accounts: ChannelAccountSnapshot[]) =>
    collectStatusIssuesFromLastError("linear", accounts),
};

export const linearChannelPlugin = createChatChannelPlugin({
  base: {
    id: "linear",
    meta: {
      id: "linear",
      label: "Linear",
      selectionLabel: "Linear Agent Channel",
      detailLabel: "Linear",
      docsPath: "/plugins/sdk-channel-plugins",
      docsLabel: "linear",
      blurb: "Linear Agent Session bridge via Cloudflare gateway.",
      aliases: ["linear-agent"],
      order: 75,
    },
    capabilities: {
      chatTypes: ["direct", "thread"],
      threads: true,
      reply: true,
    },
    reload: {
      configPrefixes: ["channels.linear"],
    },
    configSchema: buildChannelConfigSchema(LinearChannelConfigSchema),
    setupWizard: linearSetupWizard,
    config: {
      ...linearConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        name: account.config?.gatewayBaseUrl,
        audience: "active-worker-workspace",
        audienceType: "organization",
      }),
    },
    status: linearStatusAdapter,
    setup: linearSetupAdapter,
    messaging: {
      normalizeTarget: normalizeLinearTarget,
      targetResolver: {
        looksLikeId: (raw: string, normalized?: string) =>
          isLinearSessionTarget(normalized ?? raw),
        hint: "session:<agentSessionId>",
      },
    },
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      resolveTarget: ({ to, allowFrom, mode }) => {
        const candidate = normalizeLinearTarget(to);
        if (!candidate) {
          return {
            ok: false as const,
            error: new Error("Linear channel requires a target like session:<agentSessionId>."),
          };
        }

        if (
          mode === "implicit" &&
          Array.isArray(allowFrom) &&
          allowFrom.length > 0 &&
          !allowFrom.map((entry) => normalizeLinearTarget(entry)).includes(candidate)
        ) {
          return {
            ok: false as const,
            error: new Error("Linear implicit routing target must be present in allowFrom."),
          };
        }

        return {
          ok: true as const,
          to: candidate,
        };
      },
    },
    attachedResults: {
      channel: "linear",
      sendText: async (ctx) => {
        const account = resolveLinearChannelAccount(ctx.cfg);
        if (!account.config) {
          throw new Error("Linear channel is not configured.");
        }

        const agentSessionId = stripLinearTargetPrefix(ctx.to);
        if (!agentSessionId) {
          throw new Error("Linear channel target must be session:<agentSessionId>.");
        }

        const activity = buildResponseActivity(ctx.text);
        const activityWriter = getGatewayActivityWriter();
        if (!activityWriter) {
          throw new Error(
            "Linear gateway socket is not connected. Start the bridge service before sending.",
          );
        }

        const result = await activityWriter.writeActivity({
          agentSessionId,
          clientGeneratedId: `manual:${agentSessionId}:${Date.now()}`,
          content: activity,
        });

        return {
          messageId: result.agentActivityId || result.requestId,
          conversationId: agentSessionId,
          meta: {
            linearActivityType: activity.type,
          },
        };
      },
    },
  },
});

export function resolveLinearChannelAccount(cfg: unknown): ResolvedLinearChannelAccount {
  const parsed = parseChannelConfig(cfg);

  return {
    accountId: "default",
    enabled: parsed.enabled,
    configured: Boolean(parsed.config),
    config: parsed.config,
  };
}

function normalizeLinearTarget(raw: string | undefined): string | undefined {
  const value = stripLinearTargetPrefix(raw || "");
  if (!value) {
    return undefined;
  }

  return `session:${value}`;
}

function isLinearSessionTarget(raw: string): boolean {
  return Boolean(stripLinearTargetPrefix(raw));
}

function stripLinearTargetPrefix(raw: string): string {
  return raw.trim().replace(/^session:/i, "").trim();
}

function buildResponseActivity(text: string): GatewayAgentActivityContent {
  return {
    type: "response",
    body: text,
  };
}
