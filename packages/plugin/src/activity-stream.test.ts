import { describe, expect, it } from "vitest";
import {
  buildWaitingForAgentActivity,
  buildTerminalActivity,
  buildTimeoutActivity,
  createActivityStreamState,
  extractLatestAssistantText,
  syncTranscriptActivities,
} from "./activity-stream.js";

describe("activity-stream", () => {
  it("emits thinking, executing, and executed activities once across repeated transcript syncs", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Looking up the weather.",
          },
          {
            type: "tool_call",
            name: "weather_lookup",
            arguments: '{"city":"Shanghai"}',
          },
        ],
      },
      {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: "17°C, mostly cloudy",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Shanghai is 17°C and mostly cloudy.",
          },
        ],
      },
    ];

    const firstSync = syncTranscriptActivities(
      messages,
      createActivityStreamState(),
      0,
    );
    const secondSync = syncTranscriptActivities(
      messages,
      firstSync.state,
      0,
    );

    expect(firstSync.activities).toEqual([
      {
        key: "progress:0:thinking",
        content: {
          type: "thought",
          body: "Thinking...",
          ephemeral: true,
        },
      },
      {
        key: "progress:0:tool-start:0",
        content: {
          type: "action",
          action: "Executing",
          parameter: "weather_lookup",
          ephemeral: true,
        },
      },
      {
        key: "progress:1:tool-result",
        content: {
          type: "action",
          action: "Executed",
          parameter: "weather_lookup",
          result: "17°C, mostly cloudy",
        },
      },
    ]);
    expect(firstSync.state.latestAssistantText).toBe("Shanghai is 17°C and mostly cloudy.");
    expect(secondSync.activities).toEqual([]);
  });

  it("builds a waiting activity before any intermediate progress is observed", () => {
    expect(buildWaitingForAgentActivity()).toEqual({
      type: "thought",
      body: "Waiting for Agent...",
      ephemeral: true,
    });
  });

  it("builds a timeout thought that reflects the active run stage", () => {
    const waitingActivity = buildTimeoutActivity(createActivityStreamState());
    const activeActivity = buildTimeoutActivity({
      latestAssistantText: null,
      seenActivityKeys: new Set(["progress:0:thinking"]),
      pendingToolCalls: [],
    });

    expect(waitingActivity).toEqual({
      type: "thought",
      body: "Waiting for Agent...",
      ephemeral: true,
    });
    expect(activeActivity).toEqual({
      type: "thought",
      body: "Thinking...",
      ephemeral: true,
    });
  });

  it("extracts the latest assistant text from mixed content blocks", () => {
    const text = extractLatestAssistantText([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal only",
          },
          {
            type: "text",
            text: "Final answer",
          },
        ],
      },
    ]);

    expect(text).toBe("Final answer");
  });

  it("builds an elicitation terminal activity when the final assistant text is a question", () => {
    const activity = buildTerminalActivity(
      [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Which repository should I update first?",
            },
          ],
        },
      ],
      createActivityStreamState(),
    );

    expect(activity).toEqual({
      type: "elicitation",
      body: "Which repository should I update first?",
    });
  });

  it("builds a response terminal activity for non-question final text", () => {
    const activity = buildTerminalActivity(
      [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I updated the worker and the plugin.",
            },
          ],
        },
      ],
      createActivityStreamState(),
    );

    expect(activity).toEqual({
      type: "response",
      body: "I updated the worker and the plugin.",
    });
  });

  it("matches tool results by explicit toolCallId before FIFO fallback", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-a",
            name: "read_file",
          },
          {
            type: "tool_call",
            id: "call-b",
            name: "exec",
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-b",
        content: [
          {
            type: "text",
            text: "command finished",
          },
        ],
      },
    ];

    const synced = syncTranscriptActivities(messages, createActivityStreamState(), 0);

    expect(synced.activities).toEqual([
      {
        key: "progress:0:tool-start:0",
        content: {
          type: "action",
          action: "Executing",
          parameter: "read_file",
          ephemeral: true,
        },
      },
      {
        key: "progress:0:tool-start:1",
        content: {
          type: "action",
          action: "Executing",
          parameter: "exec",
          ephemeral: true,
        },
      },
      {
        key: "progress:1:tool-result",
        content: {
          type: "action",
          action: "Executed",
          parameter: "exec",
          result: "command finished",
        },
      },
    ]);

    expect(synced.state.pendingToolCalls).toEqual([
      {
        name: "read_file",
        id: "call-a",
      },
    ]);
  });

  it("matches tool results by explicit tool name before FIFO fallback", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            name: "read_file",
          },
          {
            type: "tool_call",
            name: "exec",
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: "ok",
          },
        ],
      },
    ];

    const synced = syncTranscriptActivities(messages, createActivityStreamState(), 0);

    expect(synced.activities.at(-1)).toEqual({
      key: "progress:1:tool-result",
      content: {
        type: "action",
        action: "Executed",
        parameter: "exec",
        result: "ok",
      },
    });

    expect(synced.state.pendingToolCalls).toEqual([
      {
        name: "read_file",
        id: null,
      },
    ]);
  });
});
