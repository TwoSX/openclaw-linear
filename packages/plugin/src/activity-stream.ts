import type { GatewayAgentActivityContent } from "./protocol.js";

const WAITING_FOR_AGENT_TEXT = "Waiting for Agent...";
const THINKING_TEXT = "Thinking...";
const EXECUTING_ACTION = "Executing";
const EXECUTED_ACTION = "Executed";
const DEFAULT_TOOL_PARAMETER = "local tool";
const MAX_TOOL_RESULT_LENGTH = 240;

export interface ActivityStreamState {
  latestAssistantText: string | null;
  seenActivityKeys: Set<string>;
  pendingToolCalls: PendingToolCall[];
}

export interface TranscriptDelta {
  messages: unknown[];
  offset: number;
}

interface ProgressEvent {
  key: string;
  content: GatewayAgentActivityContent;
}

interface PendingToolCall {
  name: string;
  id: string | null;
}

export function createActivityStreamState(): ActivityStreamState {
  return {
    latestAssistantText: null,
    seenActivityKeys: new Set<string>(),
    pendingToolCalls: [],
  };
}

export function buildWaitingForAgentActivity(): GatewayAgentActivityContent {
  return {
    type: "thought",
    body: WAITING_FOR_AGENT_TEXT,
    ephemeral: true,
  };
}

export function syncTranscriptActivities(
  messages: unknown[],
  state: ActivityStreamState,
  offset = 0,
): {
  activities: Array<{
    key: string;
    content: GatewayAgentActivityContent;
  }>;
  state: ActivityStreamState;
} {
  const nextState: ActivityStreamState = {
    latestAssistantText: state.latestAssistantText,
    seenActivityKeys: new Set(state.seenActivityKeys),
    pendingToolCalls: [...state.pendingToolCalls],
  };
  const activities: Array<{
    key: string;
    content: GatewayAgentActivityContent;
  }> = [];

  for (const [messageIndex, message] of messages.entries()) {
    const absoluteIndex = offset + messageIndex;
    const assistantText = extractAssistantText(message);
    if (assistantText) {
      nextState.latestAssistantText = assistantText;
    }

    const progressEvents = extractProgressEvents(message, absoluteIndex, nextState);
    for (const progressEvent of progressEvents) {
      if (nextState.seenActivityKeys.has(progressEvent.key)) {
        continue;
      }

      nextState.seenActivityKeys.add(progressEvent.key);
      activities.push({
        key: progressEvent.key,
        content: progressEvent.content,
      });
    }
  }

  return {
    activities,
    state: nextState,
  };
}

export function diffTranscriptMessages(
  previousMessages: unknown[],
  currentMessages: unknown[],
): TranscriptDelta {
  if (previousMessages.length === 0) {
    return {
      messages: currentMessages,
      offset: 0,
    };
  }

  const previousFingerprints = previousMessages.map(createMessageFingerprint);
  const currentFingerprints = currentMessages.map(createMessageFingerprint);
  const maxOverlap = Math.min(previousFingerprints.length, currentFingerprints.length);

  for (let overlap = maxOverlap; overlap >= 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (
        previousFingerprints[previousFingerprints.length - overlap + index] !==
        currentFingerprints[index]
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return {
        messages: currentMessages.slice(overlap),
        offset: overlap,
      };
    }
  }

  return {
    messages: currentMessages,
    offset: 0,
  };
}

export function describeTranscriptMessages(
  messages: unknown[],
  offset = 0,
): Array<Record<string, unknown>> {
  return messages.map((message, index) =>
    describeTranscriptMessage(message, offset + index),
  );
}

export function buildTimeoutActivity(
  state: ActivityStreamState,
): GatewayAgentActivityContent {
  if (state.seenActivityKeys.size === 0) {
    return buildWaitingForAgentActivity();
  }

  return buildThinkingActivity();
}

export function extractLatestAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const extracted = extractAssistantText(messages[index]);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

export function buildTerminalActivity(messages: unknown[], state: ActivityStreamState): GatewayAgentActivityContent {
  const assistantText =
    state.latestAssistantText ?? extractLatestAssistantText(messages);

  if (assistantText && isElicitationText(assistantText)) {
    return {
      type: "elicitation",
      body: assistantText,
    };
  }

  return {
    type: "response",
    body:
      assistantText ??
      "OpenClaw finished the local run, but no assistant message was captured.",
  };
}

function extractProgressEvents(
  message: unknown,
  messageIndex: number,
  state: ActivityStreamState,
): ProgressEvent[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const candidate = message as {
    role?: string;
    content?: unknown;
    toolCalls?: unknown;
    tool_calls?: unknown;
    name?: unknown;
    toolName?: unknown;
    tool_name?: unknown;
    toolCallId?: unknown;
    tool_call_id?: unknown;
    toolUseId?: unknown;
    tool_use_id?: unknown;
  };

  const role = normalizeRole(candidate.role);
  if (role === "assistant") {
    return extractAssistantProgressEvents(candidate, messageIndex, state);
  }

  if (role === "toolresult") {
    const toolName = resolveToolResultName(candidate, state);
    return [
      {
        key: `progress:${messageIndex}:tool-result`,
        content: buildExecutedActivity(toolName, extractToolResultText(message)),
      },
    ];
  }

  return [];
}

function describeTranscriptMessage(
  message: unknown,
  absoluteIndex: number,
): Record<string, unknown> {
  if (!message || typeof message !== "object") {
    return {
      index: absoluteIndex,
      kind: typeof message,
    };
  }

  const candidate = message as {
    role?: string;
    content?: unknown;
    toolCalls?: unknown;
    tool_calls?: unknown;
  };
  const contentSummary = summarizeContent(candidate.content);
  const topLevelToolCallCount =
    countArray(candidate.toolCalls) + countArray(candidate.tool_calls);
  const assistantText = extractAssistantText(message);

  return {
    index: absoluteIndex,
    role: candidate.role ?? null,
    textPreview: assistantText ? shortenText(assistantText, 120) : null,
    contentTypes: contentSummary.types,
    toolCallCount: topLevelToolCallCount + contentSummary.toolCallCount,
    toolResultCount:
      contentSummary.toolResultCount + (normalizeRole(candidate.role) === "toolresult" ? 1 : 0),
    toolNames: contentSummary.toolNames,
  };
}

function extractAssistantProgressEvents(
  message: {
    content?: unknown;
    toolCalls?: unknown;
    tool_calls?: unknown;
  },
  messageIndex: number,
  state: ActivityStreamState,
): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  const toolCalls = collectPendingToolCalls(message);
  const hasThinking = hasThinkingContent(message.content);

  if (hasThinking) {
    events.push({
      key: `progress:${messageIndex}:thinking`,
      content: buildThinkingActivity(),
    });
  }

  for (const [toolIndex, toolCall] of toolCalls.entries()) {
    state.pendingToolCalls.push(toolCall);
    events.push({
      key: `progress:${messageIndex}:tool-start:${toolIndex}`,
      content: buildExecutingActivity(toolCall.name),
    });
  }

  return events;
}

function buildThinkingActivity(): GatewayAgentActivityContent {
  return {
    type: "thought",
    body: THINKING_TEXT,
    ephemeral: true,
  };
}

function buildExecutingActivity(toolName: string): GatewayAgentActivityContent {
  return {
    type: "action",
    action: EXECUTING_ACTION,
    parameter: toolName || DEFAULT_TOOL_PARAMETER,
    ephemeral: true,
  };
}

function buildExecutedActivity(
  toolName: string,
  result: string | null,
): GatewayAgentActivityContent {
  return {
    type: "action",
    action: EXECUTED_ACTION,
    parameter: toolName || DEFAULT_TOOL_PARAMETER,
    result: result ?? undefined,
  };
}

function resolveToolResultName(
  message: {
    name?: unknown;
    toolName?: unknown;
    tool_name?: unknown;
    toolCallId?: unknown;
    tool_call_id?: unknown;
    toolUseId?: unknown;
    tool_use_id?: unknown;
  },
  state: ActivityStreamState,
): string {
  const explicitCallId = firstNonEmptyString(
    message.toolCallId,
    message.tool_call_id,
    message.toolUseId,
    message.tool_use_id,
  );
  if (explicitCallId) {
    const matchedById = consumePendingToolCall(state, (tool) => tool.id === explicitCallId);
    if (matchedById) {
      return matchedById.name;
    }
  }

  const explicitToolName = firstNonEmptyString(message.toolName, message.tool_name, message.name);
  if (explicitToolName) {
    const matchedByName = consumePendingToolCall(state, (tool) => tool.name === explicitToolName);
    if (matchedByName) {
      return matchedByName.name;
    }

    return explicitToolName;
  }

  return consumePendingToolCall(state, () => true)?.name ?? DEFAULT_TOOL_PARAMETER;
}

function summarizeContent(value: unknown): {
  types: string[];
  toolCallCount: number;
  toolResultCount: number;
  toolNames: string[];
} {
  const toolCalls = extractPendingToolCalls(value);

  if (!Array.isArray(value)) {
    return {
      types: [],
      toolCallCount: 0,
      toolResultCount: 0,
      toolNames: [],
    };
  }

  const types: string[] = [];
  let toolResultCount = 0;

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const part = entry as {
      type?: string;
      name?: string;
      toolName?: string;
      function?: {
        name?: string;
      } | null;
    };

    if (typeof part.type === "string" && part.type.trim()) {
      types.push(part.type);
      if (looksLikeToolResultType(part.type)) {
        toolResultCount += 1;
      }
    }
  }

  return {
    types,
    toolCallCount: toolCalls.length,
    toolResultCount,
    toolNames: toolCalls.map((tool) => tool.name),
  };
}

function extractToolResultText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidate = message as {
    text?: string;
    content?: unknown;
  };
  const text = normalizeText(candidate.text ?? "") || extractTextContent(candidate.content);
  if (!text) {
    return null;
  }

  return shortenText(text, MAX_TOOL_RESULT_LENGTH);
}

function collectPendingToolCalls(message: {
  content?: unknown;
  toolCalls?: unknown;
  tool_calls?: unknown;
}): PendingToolCall[] {
  return dedupePendingToolCalls([
    ...extractPendingToolCalls(message.content),
    ...extractPendingToolCalls(message.toolCalls),
    ...extractPendingToolCalls(message.tool_calls),
  ]).slice(0, 5);
}

function extractPendingToolCalls(value: unknown): PendingToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || !isToolCallLike(entry)) {
        return null;
      }

      const candidate = entry as {
        id?: string;
        name?: string;
        toolName?: string;
        tool_name?: string;
        toolCallId?: string;
        tool_call_id?: string;
        toolUseId?: string;
        tool_use_id?: string;
        function?: {
          name?: string;
        } | null;
      };

      const name = normalizeText(
        candidate.name ??
          candidate.toolName ??
          candidate.tool_name ??
          candidate.function?.name ??
          "",
      );
      if (!name) {
        return null;
      }

      return {
        name,
        id: firstNonEmptyString(
          candidate.id,
          candidate.toolCallId,
          candidate.tool_call_id,
          candidate.toolUseId,
          candidate.tool_use_id,
        ),
      } satisfies PendingToolCall;
    })
    .filter((entry): entry is PendingToolCall => Boolean(entry));
}

function dedupePendingToolCalls(entries: PendingToolCall[]): PendingToolCall[] {
  const seen = new Set<string>();
  const deduped: PendingToolCall[] = [];

  for (const entry of entries) {
    const key = entry.id ? `${entry.name}:${entry.id}` : entry.name;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function hasThinkingContent(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    const candidate = entry as {
      type?: string;
    };

    return candidate.type === "thinking";
  });
}

function normalizeRole(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function consumePendingToolCall(
  state: ActivityStreamState,
  predicate: (tool: PendingToolCall) => boolean,
): PendingToolCall | null {
  const index = state.pendingToolCalls.findIndex(predicate);
  if (index < 0) {
    return null;
  }

  const [matched] = state.pendingToolCalls.splice(index, 1);
  return matched ?? null;
}

function looksLikeToolResultType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return (
    normalized === "tool_result" ||
    normalized === "toolresult" ||
    normalized === "tool-output" ||
    normalized === "tool_output" ||
    normalized === "function_result" ||
    normalized === "functionresult"
  );
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function shortenText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function isElicitationText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.endsWith("?")) {
    return true;
  }

  return [
    "can you ",
    "could you ",
    "please provide",
    "please confirm",
    "please choose",
    "let me know",
    "which ",
    "what ",
    "where ",
    "when ",
    "who ",
    "would you ",
  ].some((prefix) => normalized.startsWith(prefix));
}

function isToolCallLike(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    type?: string;
    name?: string;
    toolName?: string;
    function?: {
      name?: string;
    } | null;
  };

  const type = candidate.type;
  const isToolCallType =
    type === "toolCall" ||
    type === "tool_call" ||
    type === "toolUse" ||
    type === "tool_use" ||
    type === "functionCall" ||
    type === "function_call" ||
    type === undefined;

  if (!isToolCallType) {
    return false;
  }

  return Boolean(candidate.name || candidate.toolName || candidate.function?.name);
}

function extractAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidate = message as {
    role?: string;
    text?: string;
    content?: unknown;
    message?: unknown;
  };

  if (candidate.role && candidate.role !== "assistant") {
    return null;
  }

  if (typeof candidate.text === "string") {
    const normalized = normalizeText(candidate.text);
    if (normalized) {
      return normalized;
    }
  }

  const contentText = extractTextContent(candidate.content);
  if (contentText) {
    return contentText;
  }

  if (candidate.message && typeof candidate.message === "object") {
    return extractAssistantText(candidate.message);
  }

  return null;
}

function extractTextContent(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeText(value);
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const textParts = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }

      const part = entry as {
        type?: string;
        text?: string;
        output?: string;
        content?: string;
        result?: string;
        summary?: string;
      };

      if (part.type === "thinking") {
        return "";
      }

      return normalizeText(
        part.text ?? part.output ?? part.content ?? part.result ?? part.summary ?? "",
      );
    })
    .filter(Boolean);

  if (textParts.length === 0) {
    return null;
  }

  return textParts.join("\n").trim();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function createMessageFingerprint(message: unknown): string {
  return JSON.stringify(message);
}
