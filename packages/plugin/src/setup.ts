import {
  DEFAULT_ACCOUNT_ID,
  createStandardChannelSetupStatus,
  patchTopLevelChannelConfigSection,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import {
  isLinearChannelConfigured,
  resolveLinearChannelSection,
} from "./config.js";

const CHANNEL = "linear";

interface LinearSetupAnswers {
  gatewayBaseUrl: string;
  clientAuthToken: string;
}

export const linearSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  applyAccountConfig: ({ cfg }) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel: CHANNEL,
      enabled: true,
      patch: {},
    }),
};

export const linearSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL,
  status: createStandardChannelSetupStatus({
    channelLabel: "Linear",
    configuredLabel: "configured",
    unconfiguredLabel: "needs Worker seed",
    configuredHint: "configured",
    unconfiguredHint: "needs Worker seed",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg }) => isLinearChannelConfigured(cfg),
  }),
  introNote: {
    title: "Linear setup",
    lines: [
      "先在 Cloudflare Worker 上完成 Linear OAuth。",
      "OAuth 成功页会给出一个最小 channels.linear TOML seed。",
      "OpenClaw 只保留 gateway 配置，不再本地存储 Linear token。",
    ],
  },
  resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
  resolveShouldPromptAccountIds: () => false,
  credentials: [],
  finalize: async ({ cfg, prompter }) => {
    const current = resolveLinearChannelSection(cfg);
    const answers = await promptLinearSetupAnswers(prompter, current);
    const next = applyLinearSetupConfig({
      cfg,
      answers,
    });

    await prompter.note(
      [
        "Worker 当前使用单活 workspace 路由。",
        "新一次 OAuth callback 会覆盖当前激活 organization。",
      ].join("\n"),
      "Linear workspace",
    );

    return { cfg: next };
  },
};

export function applyLinearSetupConfig(params: {
  cfg: OpenClawConfig;
  answers: LinearSetupAnswers;
}): OpenClawConfig {
  const { cfg, answers } = params;

  return patchTopLevelChannelConfigSection({
    cfg,
    channel: CHANNEL,
    enabled: true,
    patch: {
      gatewayBaseUrl: answers.gatewayBaseUrl,
      clientAuthToken: answers.clientAuthToken,
      healthMonitor: {
        enabled: false,
      },
    },
  });
}

async function promptLinearSetupAnswers(
  prompter: WizardPrompter,
  current: Record<string, unknown> | undefined,
): Promise<LinearSetupAnswers> {
  return {
    gatewayBaseUrl: await promptRequiredText(prompter, {
      message: "Linear gateway base URL",
      placeholder: "https://your-worker.example.com",
      initialValue: asString(current?.gatewayBaseUrl),
      validate: validateHttpUrl,
    }),
    clientAuthToken: await promptRequiredText(prompter, {
      message: "Client auth token (same as Worker CLIENT_AUTH_TOKEN)",
      initialValue: asString(current?.clientAuthToken),
    }),
  };
}

async function promptRequiredText(
  prompter: WizardPrompter,
  input: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  },
): Promise<string> {
  return await prompter.text({
    message: input.message,
    initialValue: input.initialValue,
    placeholder: input.placeholder,
    validate: (value) => {
      if (!value?.trim()) {
        return "This field is required.";
      }

      return input.validate?.(value.trim());
    },
  });
}

function validateHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "Expected an http or https URL.";
    }
    return undefined;
  } catch {
    return "Expected a valid URL.";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
