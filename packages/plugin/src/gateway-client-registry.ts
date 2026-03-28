import type { GatewayActivityWriter } from "./index.js";

let activityWriter: GatewayActivityWriter | null = null;

export function registerGatewayActivityWriter(writer: GatewayActivityWriter): void {
  activityWriter = writer;
}

export function unregisterGatewayActivityWriter(writer: GatewayActivityWriter): void {
  if (activityWriter === writer) {
    activityWriter = null;
  }
}

export function getGatewayActivityWriter(): GatewayActivityWriter | null {
  return activityWriter;
}
