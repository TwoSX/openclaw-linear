import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { linearChannelPlugin } from "./src/channel.js";
import { createLinearBridgeService } from "./src/service.js";

export * from "./src/index.js";
export * from "./src/channel.js";
export * from "./src/config.js";
export * from "./src/service.js";
export * from "./src/setup.js";

export default defineChannelPluginEntry({
  id: "linear",
  name: "OpenClaw Linear",
  description: "Linear agent bridge for OpenClaw",
  plugin: linearChannelPlugin,
  registerFull(api) {
    api.registerService(
      createLinearBridgeService({
        logger: api.logger,
        runtime: api.runtime,
      }),
    );
  },
});
