import { describe, expect, it } from "vitest";
import {
  createStableEventId,
  createTimestamp,
  parseEnvelope,
  pruneBufferedEvents,
  serializeEnvelope,
} from "./protocol.js";

describe("protocol helpers", () => {
  it("prefers the provided event id when present", () => {
    expect(
      createStableEventId({
        providedId: "evt-123",
        organizationId: "org-1",
        agentSessionId: "sess-1",
        eventType: "created",
      }),
    ).toBe("evt-123");
  });

  it("creates a deterministic fallback event id", () => {
    expect(
      createStableEventId({
        organizationId: "org-1",
        agentSessionId: "sess-1",
        eventType: "created",
        createdAt: "2026-03-27T09:00:00.000Z",
      }),
    ).toBe("org-1:sess-1:created:2026-03-27T09:00:00.000Z");
  });

  it("round-trips control envelopes through serialize/parse", () => {
    const envelope = {
      type: "control" as const,
      eventId: "ctrl-1",
      timestamp: "2026-03-27T09:00:00.000Z",
      payload: {
        action: "connected" as const,
        instanceId: "inst-1",
      },
    };

    expect(parseEnvelope(serializeEnvelope(envelope))).toEqual(envelope);
  });

  it("accepts activity request envelopes", () => {
    const envelope = {
      type: "activity_request" as const,
      eventId: "req-1",
      timestamp: "2026-03-27T09:00:00.000Z",
      payload: {
        requestId: "req-1",
        instanceId: "inst-1",
        agentSessionId: "sess-1",
        clientGeneratedId: "evt-1:response",
        content: {
          type: "response" as const,
          body: "done",
        },
      },
    };

    expect(parseEnvelope(serializeEnvelope(envelope))).toEqual(envelope);
  });

  it("returns null for invalid envelopes", () => {
    expect(parseEnvelope("{")).toBeNull();
    expect(parseEnvelope(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  it("prunes old buffered events and keeps the latest entries", () => {
    const now = Date.parse("2026-03-27T09:10:00.000Z");
    const events = [
      { timestamp: "2026-03-27T09:00:00.000Z", id: "old" },
      { timestamp: "2026-03-27T09:09:10.000Z", id: "new-1" },
      { timestamp: "2026-03-27T09:09:20.000Z", id: "new-2" },
      { timestamp: "2026-03-27T09:09:30.000Z", id: "new-3" },
    ];

    expect(
      pruneBufferedEvents(events, { maxItems: 2, maxAgeMs: 60_000 }, now).map((event) => event.id),
    ).toEqual(["new-2", "new-3"]);
  });

  it("normalizes Date timestamps to ISO strings", () => {
    expect(createTimestamp(new Date("2026-03-27T09:00:00.000Z"))).toBe(
      "2026-03-27T09:00:00.000Z",
    );
  });
});
