import type { OpenClawLinearPluginConfig } from "./index.js";

export interface ResolvedLinearChannelConfig extends OpenClawLinearPluginConfig {
  promptContextTemplate: string;
  debugTranscriptTrace: boolean;
}

export interface ParsedOpenClawLinearPluginConfig {
  enabled: boolean;
  config: ResolvedLinearChannelConfig | null;
  issues: string[];
}

export const DEFAULT_PROMPT_CONTEXT_TEMPLATE = `You are handling a Linear agent session.

Below is the initial task context provided by Linear. Treat it as the primary context for this task.
Prioritize actions based on the current issue context. If information is missing, ask concise questions first and do not invent facts.

<linear_prompt_context>
$issueContext
</linear_prompt_context>`;
export const PROMPT_CONTEXT_TEMPLATE_VARIABLE = "$issueContext";

const REQUIRED_STRING_FIELDS = ["gatewayBaseUrl", "clientAuthToken"] as const;

export function parseChannelConfig(cfg: unknown): ParsedOpenClawLinearPluginConfig {
  const raw = resolveLinearChannelSection(cfg);
  const enabled = raw?.enabled !== false;
  const issues: string[] = [];

  if (!raw) {
    return {
      enabled: false,
      config: null,
      issues: ["channels.linear config is missing"],
    };
  }

  for (const key of REQUIRED_STRING_FIELDS) {
    const value = raw[key];
    if (typeof value !== "string" || !value.trim()) {
      issues.push(`missing required config field: channels.linear.${key}`);
    }
  }

  if (issues.length > 0) {
    return {
      enabled,
      config: null,
      issues,
    };
  }

  return {
    enabled,
    config: {
      gatewayBaseUrl: String(raw.gatewayBaseUrl),
      clientAuthToken: String(raw.clientAuthToken),
      promptContextTemplate: resolvePromptContextTemplate(raw.promptContextTemplate),
      debugTranscriptTrace: raw.debugTranscriptTrace === true,
    },
    issues: [],
  };
}

export function isLinearChannelConfigured(cfg: unknown): boolean {
  return Boolean(parseChannelConfig(cfg).config);
}

export function resolveLinearChannelSection(cfg: unknown): Record<string, unknown> | undefined {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }

  const channels = (cfg as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object") {
    return undefined;
  }

  const linear = (channels as Record<string, unknown>).linear;
  if (!linear || typeof linear !== "object") {
    return undefined;
  }

  return linear as Record<string, unknown>;
}

export function resolvePromptContextTemplate(value: unknown): string {
  return resolveOptionalText(value, DEFAULT_PROMPT_CONTEXT_TEMPLATE);
}

function resolveOptionalText(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  return normalized || fallback;
}
