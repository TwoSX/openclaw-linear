import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentActivity: vi.fn(),
  agentActivity: vi.fn(),
  LinearClient: vi.fn(),
}));

vi.mock("@linear/sdk", () => {
  class LinearError extends Error {
    status?: number;

    constructor(message = "Linear error", options?: { status?: number }) {
      super(message);
      this.name = new.target.name;
      this.status = options?.status;
    }
  }

  class NetworkLinearError extends LinearError {}
  class InternalLinearError extends LinearError {}
  class LockTimeoutLinearError extends LinearError {}

  class RatelimitedLinearError extends LinearError {
    retryAfter?: number;

    constructor(message = "Rate limited", options?: { status?: number; retryAfter?: number }) {
      super(message, options);
      this.retryAfter = options?.retryAfter;
    }
  }

  function MockLinearClient() {
    mocks.LinearClient();
    return {
      createAgentActivity: mocks.createAgentActivity,
      agentActivity: mocks.agentActivity,
    };
  }

  return {
    InternalLinearError,
    LinearClient: MockLinearClient,
    LinearError,
    LockTimeoutLinearError,
    NetworkLinearError,
    RatelimitedLinearError,
  };
});

vi.mock("@linear/sdk/webhooks", () => ({
  LinearWebhookClient: class {
    createHandler() {
      return vi.fn();
    }
  },
}));

import { LinearError, NetworkLinearError, RatelimitedLinearError } from "@linear/sdk";
import { createAgentActivity } from "./linear-api.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createLinearSdkError<T extends Error>(
  ErrorType: new (...args: never[]) => T,
  message: string,
  properties: Record<string, unknown> = {},
): T {
  const error = Object.create(ErrorType.prototype) as T & Record<string, unknown>;
  error.message = message;
  error.name = ErrorType.name;
  Object.assign(error, properties);
  return error;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("createAgentActivity", () => {
  it("reuses the same generated id across retry attempts", async () => {
    const payload = {
      success: true,
      lastSyncId: "sync-1",
      agentActivityId: "server-activity-1",
      agentActivity: Promise.resolve({ id: "server-activity-1" }),
    };

    mocks.createAgentActivity
      .mockRejectedValueOnce(createLinearSdkError(NetworkLinearError, "fetch failed"))
      .mockResolvedValueOnce(payload);

    await expect(
      createAgentActivity({
        accessToken: "token",
        agentSessionId: "session-1",
        content: {
          type: "response",
          body: "completed",
        },
        retry: {
          initialDelayMs: 0,
          maxDelayMs: 0,
        },
      }),
    ).resolves.toBe(payload);

    expect(mocks.createAgentActivity).toHaveBeenCalledTimes(2);
    const firstAttempt = mocks.createAgentActivity.mock.calls[0]?.[0];
    const secondAttempt = mocks.createAgentActivity.mock.calls[1]?.[0];
    expect(firstAttempt.id).toMatch(UUID_PATTERN);
    expect(secondAttempt.id).toBe(firstAttempt.id);
    expect(mocks.agentActivity).toHaveBeenCalledWith(firstAttempt.id);
  });

  it("backs off using retryAfter when rate limited", async () => {
    vi.useFakeTimers();

    const payload = {
      success: true,
      lastSyncId: "sync-2",
      agentActivityId: "server-activity-2",
      agentActivity: Promise.resolve({ id: "server-activity-2" }),
    };

    mocks.createAgentActivity
      .mockRejectedValueOnce(
        createLinearSdkError(RatelimitedLinearError, "Too many requests", { retryAfter: 1 }),
      )
      .mockResolvedValueOnce(payload);

    const writePromise = createAgentActivity({
      accessToken: "token",
      agentSessionId: "session-2",
      content: {
        type: "response",
        body: "backoff",
      },
      retry: {
        maxAttempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 2_000,
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createAgentActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.createAgentActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(writePromise).resolves.toBe(payload);
    expect(mocks.createAgentActivity).toHaveBeenCalledTimes(2);
  });

  it("recovers an existing activity when a duplicate-id error follows a prior success", async () => {
    const existingActivity = { id: "activity-123" };

    mocks.createAgentActivity.mockRejectedValueOnce(
      createLinearSdkError(LinearError, "Agent activity already exists"),
    );
    mocks.agentActivity.mockResolvedValueOnce(existingActivity);

    const payload = await createAgentActivity({
      accessToken: "token",
      agentSessionId: "session-3",
      content: {
        type: "response",
        body: "duplicate recovery",
      },
      id: "activity-123",
      retry: {
        maxAttempts: 1,
      },
    });

    expect(mocks.createAgentActivity).toHaveBeenCalledTimes(1);
    expect(mocks.agentActivity).toHaveBeenCalledWith("activity-123");
    expect(payload.success).toBe(true);
    expect(payload.agentActivityId).toBe("activity-123");
    await expect(payload.agentActivity).resolves.toBe(existingActivity);
  });

  it("maps clientGeneratedId to a stable UUID-compatible activity id", async () => {
    const payload = {
      success: true,
      lastSyncId: "sync-3",
      agentActivityId: "server-activity-3",
      agentActivity: Promise.resolve({ id: "server-activity-3" }),
    };

    mocks.createAgentActivity.mockResolvedValue(payload);

    await createAgentActivity({
      accessToken: "token",
      agentSessionId: "session-4",
      clientGeneratedId: "event-42",
      content: {
        type: "response",
        body: "stable id",
      },
    });

    await createAgentActivity({
      accessToken: "token",
      agentSessionId: "session-4",
      clientGeneratedId: "event-42",
      content: {
        type: "response",
        body: "stable id",
      },
    });

    const firstId = mocks.createAgentActivity.mock.calls[0]?.[0]?.id;
    const secondId = mocks.createAgentActivity.mock.calls[1]?.[0]?.id;
    expect(firstId).toMatch(UUID_PATTERN);
    expect(secondId).toBe(firstId);
  });
});
