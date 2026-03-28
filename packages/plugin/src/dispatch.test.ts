import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROMPT_CONTEXT_TEMPLATE } from "./config.js";
import { handleLinearGatewayEvent } from "./dispatch.js";

describe("handleLinearGatewayEvent", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("streams tool actions before the final response", async () => {
    const activityWriter = {
      writeActivity: vi.fn().mockResolvedValue({
        ok: true,
      }),
    };

    const runtime = {
      subagent: {
        run: vi.fn().mockResolvedValue({
          runId: "run-1",
        }),
        waitForRun: vi
          .fn()
          .mockResolvedValueOnce({
            status: "timeout",
          })
          .mockResolvedValueOnce({
            status: "ok",
          }),
        getSessionMessages: vi
          .fn()
          .mockResolvedValueOnce({
            messages: [],
          })
          .mockResolvedValueOnce({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_call",
                    name: "read_file",
                    arguments: '{"path":"src/dispatch.ts"}',
                  },
                ],
              },
            ],
          })
          .mockResolvedValueOnce({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_call",
                    name: "read_file",
                    arguments: '{"path":"src/dispatch.ts"}',
                  },
                ],
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Implemented the richer Linear activity stream.",
                  },
                ],
              },
            ],
          }),
      },
    };

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    await handleLinearGatewayEvent({
      event: {
        type: "webhook_event",
        eventId: "evt-1",
        timestamp: "2026-03-26T10:00:00.000Z",
        payload: {
          organizationId: "org-1",
          eventType: "created",
          agentSessionId: "session-1",
          raw: {
            promptContext:
              "Issue: Improve plugin-side activity streaming\n\nPlease emit richer Linear activities.",
            agentSession: {
              id: "session-1",
              issue: {
                title: "Improve plugin-side activity streaming",
              },
              comment: {
                body: "Emit richer Linear activities.",
              },
            },
          },
        },
      },
      activityWriter: activityWriter as never,
      runtime: runtime as never,
      logger: logger as never,
    });

    expect(runtime.subagent.run).toHaveBeenCalledWith({
      sessionKey: "linear:org-1:session-1",
      message: DEFAULT_PROMPT_CONTEXT_TEMPLATE.replace(
        "$issueContext",
        "Issue: Improve plugin-side activity streaming\n\nPlease emit richer Linear activities.",
      ),
      deliver: false,
      idempotencyKey: "evt-1",
    });
    expect(activityWriter.writeActivity).toHaveBeenCalledTimes(3);
    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(1, {
      agentSessionId: "session-1",
      clientGeneratedId: "evt-1:start",
      content: {
        type: "thought",
        body: "Waiting for Agent...",
        ephemeral: true,
      },
    });
    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(2, {
      agentSessionId: "session-1",
      clientGeneratedId: "evt-1:action:progress:0:tool-start:0",
      content: {
        type: "action",
        action: "Executing",
        parameter: "read_file",
        ephemeral: true,
      },
    });
    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(3, {
      agentSessionId: "session-1",
      clientGeneratedId: "evt-1:response",
      content: {
        type: "response",
        body: "Implemented the richer Linear activity stream.",
      },
    });
  });

  it("uses the prompted agent activity body to continue an existing session", async () => {
    const activityWriter = {
      writeActivity: vi.fn().mockResolvedValue({
        ok: true,
      }),
    };

    const runtime = {
      subagent: {
        run: vi.fn().mockResolvedValue({
          runId: "run-2",
        }),
        waitForRun: vi.fn().mockResolvedValue({
          status: "ok",
        }),
        getSessionMessages: vi
          .fn()
          .mockResolvedValueOnce({
            messages: [],
          })
          .mockResolvedValueOnce({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Added the missing tests.",
                  },
                ],
              },
            ],
          }),
      },
    };

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    await handleLinearGatewayEvent({
      event: {
        type: "webhook_event",
        eventId: "evt-2",
        timestamp: "2026-03-26T10:05:00.000Z",
        payload: {
          organizationId: "org-1",
          eventType: "prompted",
          agentSessionId: "session-1",
          raw: {
            agentActivity: {
              content: {
                body: "Please also add regression coverage.",
              },
            },
            agentSession: {
              id: "session-1",
            },
          },
        },
      },
      activityWriter: activityWriter as never,
      runtime: runtime as never,
      logger: logger as never,
    });

    expect(runtime.subagent.run).toHaveBeenCalledWith({
      sessionKey: "linear:org-1:session-1",
      message: "Please also add regression coverage.",
      deliver: false,
      idempotencyKey: "evt-2",
    });
    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(1, {
      agentSessionId: "session-1",
      clientGeneratedId: "evt-2:start",
      content: {
        type: "thought",
        body: "Waiting for Agent...",
        ephemeral: true,
      },
    });
    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(2, {
      agentSessionId: "session-1",
      clientGeneratedId: "evt-2:response",
      content: {
        type: "response",
        body: "Added the missing tests.",
      },
    });
  });

  it("writes an elicitation when the final assistant message asks for user input", async () => {
    const activityWriter = {
      writeActivity: vi.fn().mockResolvedValue({
        ok: true,
      }),
    };

    const runtime = {
      subagent: {
        run: vi.fn().mockResolvedValue({
          runId: "run-3",
        }),
        waitForRun: vi.fn().mockResolvedValue({
          status: "ok",
        }),
        getSessionMessages: vi
          .fn()
          .mockResolvedValueOnce({
            messages: [],
          })
          .mockResolvedValueOnce({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Which repository should I modify first?",
                  },
                ],
              },
            ],
          }),
      },
    };

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    await handleLinearGatewayEvent({
      event: {
        type: "webhook_event",
        eventId: "evt-3",
        timestamp: "2026-03-26T10:06:00.000Z",
        payload: {
          organizationId: "org-1",
          eventType: "created",
          agentSessionId: "session-2",
          raw: {
            promptContext: "Please continue and ask if you need clarification.",
            agentSession: {
              id: "session-2",
            },
          },
        },
      },
      activityWriter: activityWriter as never,
      runtime: runtime as never,
      logger: logger as never,
    });

    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(2, {
      agentSessionId: "session-2",
      clientGeneratedId: "evt-3:response",
      content: {
        type: "elicitation",
        body: "Which repository should I modify first?",
      },
    });
  });

  it("applies a custom prompt context template for created events", async () => {
    const activityWriter = {
      writeActivity: vi.fn().mockResolvedValue({
        ok: true,
      }),
    };

    const runtime = {
      subagent: {
        run: vi.fn().mockResolvedValue({
          runId: "run-template",
        }),
        waitForRun: vi.fn().mockResolvedValue({
          status: "ok",
        }),
        getSessionMessages: vi
          .fn()
          .mockResolvedValueOnce({
            messages: [],
          })
          .mockResolvedValueOnce({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Done.",
                  },
                ],
              },
            ],
          }),
      },
    };

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    await handleLinearGatewayEvent({
      event: {
        type: "webhook_event",
        eventId: "evt-template",
        timestamp: "2026-03-26T10:06:30.000Z",
        payload: {
          organizationId: "org-1",
          eventType: "created",
          agentSessionId: "session-template",
          raw: {
            promptContext: "Context from Linear.",
            agentSession: {
              id: "session-template",
            },
          },
        },
      },
      activityWriter: activityWriter as never,
      runtime: runtime as never,
      logger: logger as never,
      promptContextTemplate: "Linear issue context:\n\n$issueContext",
    });

    expect(runtime.subagent.run).toHaveBeenCalledWith({
      sessionKey: "linear:org-1:session-template",
      message: "Linear issue context:\n\nContext from Linear.",
      deliver: false,
      idempotencyKey: "evt-template",
    });
  });

  it("appends the raw prompt context when the template omits $issueContext", async () => {
    const activityWriter = {
      writeActivity: vi.fn().mockResolvedValue({
        ok: true,
      }),
    };

    const runtime = {
      subagent: {
        run: vi.fn().mockResolvedValue({
          runId: "run-template-fallback",
        }),
        waitForRun: vi.fn().mockResolvedValue({
          status: "ok",
        }),
        getSessionMessages: vi
          .fn()
          .mockResolvedValueOnce({
            messages: [],
          })
          .mockResolvedValueOnce({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Done.",
                  },
                ],
              },
            ],
          }),
      },
    };

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    await handleLinearGatewayEvent({
      event: {
        type: "webhook_event",
        eventId: "evt-template-fallback",
        timestamp: "2026-03-26T10:07:00.000Z",
        payload: {
          organizationId: "org-1",
          eventType: "created",
          agentSessionId: "session-template-fallback",
          raw: {
            promptContext: "Context from Linear.",
            agentSession: {
              id: "session-template-fallback",
            },
          },
        },
      },
      activityWriter: activityWriter as never,
      runtime: runtime as never,
      logger: logger as never,
      promptContextTemplate: "Linear issue context only.",
    });

    expect(runtime.subagent.run).toHaveBeenCalledWith({
      sessionKey: "linear:org-1:session-template-fallback",
      message: "Linear issue context only.\n\nContext from Linear.",
      deliver: false,
      idempotencyKey: "evt-template-fallback",
    });
  });

  it("uses only transcript messages added by the current run for the final response", async () => {
    const activityWriter = {
      writeActivity: vi.fn().mockResolvedValue({
        ok: true,
      }),
    };

    const runtime = {
      subagent: {
        run: vi.fn().mockResolvedValue({
          runId: "run-4",
        }),
        waitForRun: vi.fn().mockResolvedValue({
          status: "ok",
        }),
        getSessionMessages: vi
          .fn()
          .mockResolvedValueOnce({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "我是小龙虾，贰师兄的 AI 助手。",
                  },
                ],
              },
            ],
          })
          .mockResolvedValueOnce({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "我是小龙虾，贰师兄的 AI 助手。",
                  },
                ],
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "我现在跑在 OpenClaw 里，环境大概是：主机是贰师兄的 MacBook Pro。",
                  },
                ],
              },
            ],
          }),
      },
    };

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    await handleLinearGatewayEvent({
      event: {
        type: "webhook_event",
        eventId: "evt-4",
        timestamp: "2026-03-27T04:42:39.418Z",
        payload: {
          organizationId: "org-1",
          eventType: "prompted",
          agentSessionId: "session-2",
          raw: {
            agentActivity: {
              body: "你目前运行什么环境？",
            },
            agentSession: {
              id: "session-2",
            },
          },
        },
      },
      activityWriter: activityWriter as never,
      runtime: runtime as never,
      logger: logger as never,
    });

    expect(runtime.subagent.run).toHaveBeenCalledWith({
      sessionKey: "linear:org-1:session-2",
      message: "你目前运行什么环境？",
      deliver: false,
      idempotencyKey: "evt-4",
    });
    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(2, {
      agentSessionId: "session-2",
      clientGeneratedId: "evt-4:response",
      content: {
        type: "response",
        body: "我现在跑在 OpenClaw 里，环境大概是：主机是贰师兄的 MacBook Pro。",
      },
    });
  });

  it("acknowledges a stop signal without starting a new local run", async () => {
    const activityWriter = {
      writeActivity: vi.fn().mockResolvedValue({
        ok: true,
      }),
    };

    const runtime = {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSessionMessages: vi.fn(),
      },
    };

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    await handleLinearGatewayEvent({
      event: {
        type: "webhook_event",
        eventId: "evt-stop",
        timestamp: "2026-03-26T10:05:00.000Z",
        payload: {
          organizationId: "org-1",
          eventType: "prompted",
          agentSessionId: "session-1",
          raw: {
            agentActivity: {
              signal: "stop",
              signalMetadata: {
                type: "stop",
              },
            },
            agentSession: {
              id: "session-1",
            },
          },
        },
      },
      activityWriter: activityWriter as never,
      runtime: runtime as never,
      logger: logger as never,
    });

    expect(runtime.subagent.run).not.toHaveBeenCalled();
    expect(activityWriter.writeActivity).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      clientGeneratedId: "evt-stop:stopped",
      content: {
        type: "response",
        body: "OpenClaw received the stop signal and skipped starting new local work for this event.",
      },
    });
  });

  it("writes an error activity when the local run throws before completion", async () => {
    const activityWriter = {
      writeActivity: vi.fn().mockResolvedValue({
        ok: true,
      }),
    };

    const runtime = {
      subagent: {
        run: vi.fn().mockRejectedValue(new Error("runner exploded")),
        waitForRun: vi.fn(),
        getSessionMessages: vi.fn(),
      },
    };

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    await handleLinearGatewayEvent({
      event: {
        type: "webhook_event",
        eventId: "evt-error",
        timestamp: "2026-03-26T10:05:00.000Z",
        payload: {
          organizationId: "org-1",
          eventType: "created",
          agentSessionId: "session-1",
          raw: {
            promptContext: "Please continue.",
            agentSession: {
              id: "session-1",
            },
          },
        },
      },
      activityWriter: activityWriter as never,
      runtime: runtime as never,
      logger: logger as never,
    });

    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(1, {
      agentSessionId: "session-1",
      clientGeneratedId: "evt-error:start",
      content: {
        type: "thought",
        body: "Waiting for Agent...",
        ephemeral: true,
      },
    });
    expect(activityWriter.writeActivity).toHaveBeenNthCalledWith(2, {
      agentSessionId: "session-1",
      clientGeneratedId: "evt-error:error",
      content: {
        type: "error",
        body: "OpenClaw failed before finishing the local run: runner exploded",
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to process inbound Linear event: runner exploded"),
    );
  });
});
