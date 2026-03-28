import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_CONTEXT_TEMPLATE,
  parseChannelConfig,
  resolveLinearChannelSection,
} from "./config.js";

const validConfig = {
  channels: {
    linear: {
      enabled: true,
      gatewayBaseUrl: "https://worker.example.com",
      clientAuthToken: "client-token",
    },
  },
} satisfies Record<string, unknown>;

describe("parseChannelConfig", () => {
  it("parses a valid channels.linear config", () => {
    const parsed = parseChannelConfig(validConfig);
    expect(parsed.enabled).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.config?.gatewayBaseUrl).toBe("https://worker.example.com");
    expect(parsed.config?.promptContextTemplate).toBe(DEFAULT_PROMPT_CONTEXT_TEMPLATE);
    expect(parsed.config?.debugTranscriptTrace).toBe(false);
  });

  it("parses a custom prompt context template", () => {
    const parsed = parseChannelConfig({
      channels: {
        linear: {
          enabled: true,
          gatewayBaseUrl: "https://worker.example.com",
          clientAuthToken: "client-token",
          promptContextTemplate: "Prefix\n\n$issueContext",
        },
      },
    });

    expect(parsed.config?.promptContextTemplate).toBe("Prefix\n\n$issueContext");
  });

  it("returns issues when required fields are missing", () => {
    const parsed = parseChannelConfig({
      channels: {
        linear: {
          enabled: true,
        },
      },
    });

    expect(parsed.config).toBeNull();
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("treats missing channels.linear config as disabled", () => {
    const parsed = parseChannelConfig(undefined);
    expect(parsed.enabled).toBe(false);
    expect(parsed.config).toBeNull();
  });

  it("resolves the raw channels.linear section", () => {
    expect(resolveLinearChannelSection(validConfig)).toMatchObject({
      gatewayBaseUrl: "https://worker.example.com",
    });
  });
});
