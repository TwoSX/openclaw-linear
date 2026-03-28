import { describe, expect, it } from "vitest";
import { applyLinearSetupConfig } from "./setup.js";

describe("linear setup helpers", () => {
  it("writes a minimal channels.linear config section", () => {
    const next = applyLinearSetupConfig({
      cfg: {},
      answers: {
        gatewayBaseUrl: "https://worker.example.com",
        clientAuthToken: "client-secret",
      },
    }) as {
      channels?: {
        linear?: Record<string, unknown>;
      };
    };

    expect(next.channels?.linear).toMatchObject({
      enabled: true,
      gatewayBaseUrl: "https://worker.example.com",
      clientAuthToken: "client-secret",
      healthMonitor: {
        enabled: false,
      },
    });
  });
});
