import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { linearChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(linearChannelPlugin);
