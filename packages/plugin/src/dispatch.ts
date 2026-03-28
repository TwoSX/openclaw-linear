import type {
  GatewayAgentActivityContent,
  GatewayWebhookEnvelope,
} from "./protocol.js";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  buildWaitingForAgentActivity,
  buildTerminalActivity,
  buildTimeoutActivity,
  createActivityStreamState,
  describeTranscriptMessages,
  diffTranscriptMessages,
  syncTranscriptActivities,
} from "./activity-stream.js";
import {
  DEFAULT_PROMPT_CONTEXT_TEMPLATE,
  PROMPT_CONTEXT_TEMPLATE_VARIABLE,
  resolvePromptContextTemplate,
} from "./config.js";
import type { GatewayActivityWriter } from "./index.js";
import { noteLinearOutbound, noteLinearRuntimeError } from "./status-store.js";

const RUN_TIMEOUT_MS = 60_000;
const RUN_POLL_INTERVAL_MS = 5_000;
const SESSION_MESSAGE_LIMIT = 100;
const FINAL_TRANSCRIPT_SETTLE_ATTEMPTS = 3;
const FINAL_TRANSCRIPT_SETTLE_DELAY_MS = 500;

export async function handleLinearGatewayEvent(params: {
  event: GatewayWebhookEnvelope;
  activityWriter: GatewayActivityWriter;
  runtime: PluginRuntime;
  logger: PluginLogger;
  promptContextTemplate?: string;
  debugTranscriptTrace?: boolean;
}): Promise<void> {
  const {
    event,
    activityWriter,
    runtime,
    logger,
    promptContextTemplate = DEFAULT_PROMPT_CONTEXT_TEMPLATE,
    debugTranscriptTrace = false,
  } = params;
  const raw = event.payload.raw as {
    promptContext?: string | null;
    agentActivity?: {
      signal?: string | null;
      signalMetadata?: Record<string, unknown> | null;
      body?: string | null;
      content?: {
        body?: string | null;
      } | null;
    } | null;
    agentSession?: {
      id?: string;
      issue?: {
        title?: string | null;
      } | null;
      comment?: {
        body?: string | null;
      } | null;
    } | null;
  };

  const agentSessionId = raw.agentSession?.id ?? event.payload.agentSessionId;
  if (!agentSessionId) {
    logger.warn("[openclaw-linear] inbound event missing agentSessionId");
    return;
  }

  const sessionKey = buildSessionKey(event.payload.organizationId, agentSessionId);
  const stopSignal = extractStopSignal(raw.agentActivity);
  if (stopSignal) {
    logger.info?.("[openclaw-linear] received Linear stop signal; skipping new local run");
    await writeLinearActivity({
      activityWriter,
      agentSessionId,
      clientGeneratedId: buildActivityClientGeneratedId(event.eventId, "stopped"),
      content: {
        type: "response",
        body: "OpenClaw received the stop signal and skipped starting new local work for this event.",
      },
      logger,
    });
    return;
  }

  try {
    const runMessage = buildUserPrompt(raw, event, promptContextTemplate);
    logTranscriptTrace(logger, debugTranscriptTrace, "run:start", {
      eventType: event.payload.eventType,
      agentSessionId,
      sessionKey,
      promptContextPresent: Boolean(raw.promptContext?.trim()),
      promptContextTemplateHasVariable: resolvePromptContextTemplate(
        promptContextTemplate,
      ).includes(PROMPT_CONTEXT_TEMPLATE_VARIABLE),
      runMessagePreview: shortenForLog(runMessage),
    });
    let previousTranscriptMessages = await getSessionMessagesSafe({
      runtime,
      sessionKey,
      logger,
    });

    await writeLinearActivity({
      activityWriter,
      agentSessionId,
      clientGeneratedId: buildActivityClientGeneratedId(event.eventId, "start"),
      content: buildWaitingForAgentActivity(),
      logger,
    });

    const run = await runtime.subagent.run({
      sessionKey,
      message: runMessage,
      deliver: false,
      idempotencyKey: event.eventId,
    });

    let activityState = createActivityStreamState();
    const maxPolls = Math.max(1, Math.ceil(RUN_TIMEOUT_MS / RUN_POLL_INTERVAL_MS));

    for (let pollIndex = 0; pollIndex < maxPolls; pollIndex += 1) {
      const remainingMs = RUN_TIMEOUT_MS - pollIndex * RUN_POLL_INTERVAL_MS;
      const wait = await runtime.subagent.waitForRun({
        runId: run.runId,
        timeoutMs: Math.min(RUN_POLL_INTERVAL_MS, remainingMs),
      });
      const transcriptMessages = await getSessionMessagesSafe({
        runtime,
        sessionKey,
        logger,
      });
      const transcriptDelta = diffTranscriptMessages(
        previousTranscriptMessages,
        transcriptMessages,
      );
      previousTranscriptMessages = transcriptMessages;
      logTranscriptTrace(logger, debugTranscriptTrace, "run:poll", {
        eventType: event.payload.eventType,
        agentSessionId,
        waitStatus: wait.status,
        deltaCount: transcriptDelta.messages.length,
        delta: describeTranscriptMessages(
          transcriptDelta.messages,
          transcriptDelta.offset,
        ),
      });

      if (wait.status === "timeout") {
        const streamed = syncTranscriptActivities(
          transcriptDelta.messages,
          activityState,
          transcriptDelta.offset,
        );
        activityState = streamed.state;

        for (const activity of streamed.activities) {
          await writeLinearActivity({
            activityWriter,
            agentSessionId,
            clientGeneratedId: buildActivityClientGeneratedId(
              event.eventId,
              `action:${activity.key}`,
            ),
            content: activity.content,
            logger,
          });
        }

        continue;
      }

      if (wait.status === "error") {
        await writeLinearActivity({
          activityWriter,
          agentSessionId,
          clientGeneratedId: buildActivityClientGeneratedId(event.eventId, "error"),
          content: {
            type: "error",
            body: wait.error || "OpenClaw local run failed.",
          },
          logger,
        });
        return;
      }

      const completedSync = syncTranscriptActivities(
        transcriptDelta.messages,
        activityState,
        transcriptDelta.offset,
      );
      activityState = completedSync.state;
      const settledTranscript = await settleCompletedRunTranscript({
        runtime,
        sessionKey,
        previousTranscriptMessages,
        activityState,
        logger,
        debugTranscriptTrace,
      });
      previousTranscriptMessages = settledTranscript.messages;
      activityState = settledTranscript.state;

      await writeLinearActivity({
        activityWriter,
        agentSessionId,
        clientGeneratedId: buildActivityClientGeneratedId(event.eventId, "response"),
        content: buildTerminalActivity([], activityState),
        logger,
      });
      return;
    }

    await writeLinearActivity({
      activityWriter,
      agentSessionId,
      clientGeneratedId: buildActivityClientGeneratedId(event.eventId, "timeout"),
      content: buildTimeoutActivity(activityState),
      logger,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      `[openclaw-linear] failed to process inbound Linear event: ${message}`,
    );

    await writeLinearActivity({
      activityWriter,
      agentSessionId,
      clientGeneratedId: buildActivityClientGeneratedId(event.eventId, "error"),
      content: {
        type: "error",
        body: `OpenClaw failed before finishing the local run: ${message}`,
      },
      logger,
    });
  }
}

function buildSessionKey(
  organizationId: string | undefined,
  agentSessionId: string,
): string {
  return `linear:${organizationId || "unknown-org"}:${agentSessionId}`;
}

function buildUserPrompt(
  raw: {
    promptContext?: string | null;
    agentActivity?: {
      body?: string | null;
      content?: {
        body?: string | null;
      } | null;
    } | null;
    agentSession?: {
      issue?: {
        title?: string | null;
      } | null;
      comment?: {
        body?: string | null;
      } | null;
    } | null;
  },
  event: GatewayWebhookEnvelope,
  promptContextTemplate: string,
): string {
  const promptedBody = extractAgentActivityBody(raw.agentActivity);
  if (isPromptedEvent(event.payload.eventType) && promptedBody) {
    return promptedBody;
  }

  const promptContext = raw.promptContext?.trim();
  if (promptContext) {
    return isCreatedEvent(event.payload.eventType)
      ? applyPromptContextTemplate(promptContext, promptContextTemplate)
      : promptContext;
  }

  const issueTitle = raw.agentSession?.issue?.title?.trim();
  const commentBody = raw.agentSession?.comment?.body?.trim();

  if (issueTitle && commentBody) {
    return `Issue: ${issueTitle}\n\nTask: ${commentBody}`;
  }

  if (issueTitle) {
    return `Task: ${issueTitle}`;
  }

  if (commentBody) {
    return `Task: ${commentBody}`;
  }

  return `Linear agent event (${event.payload.eventType})\n\n${JSON.stringify(event.payload.raw, null, 2)}`;
}

function extractAgentActivityBody(
  activity:
    | {
        signal?: string | null;
        signalMetadata?: Record<string, unknown> | null;
        body?: string | null;
        content?: {
          body?: string | null;
        } | null;
      }
    | null
    | undefined,
): string | undefined {
  const directBody = activity?.body?.trim();
  if (directBody) {
    return directBody;
  }

  const contentBody = activity?.content?.body?.trim();
  if (contentBody) {
    return contentBody;
  }

  return undefined;
}

function extractStopSignal(
  activity:
    | {
        signal?: string | null;
        signalMetadata?: Record<string, unknown> | null;
      }
    | null
    | undefined,
): string | null {
  const normalizedSignal = activity?.signal?.trim().toLowerCase();
  if (normalizedSignal === "stop") {
    return normalizedSignal;
  }

  const metadata = activity?.signalMetadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  for (const value of Object.values(metadata)) {
    if (typeof value === "string" && value.trim().toLowerCase() === "stop") {
      return "stop";
    }
  }

  return null;
}

function isPromptedEvent(eventType: string): boolean {
  const normalized = eventType.trim().toLowerCase();
  return normalized === "prompted" || normalized.endsWith(".prompted");
}

function isCreatedEvent(eventType: string): boolean {
  const normalized = eventType.trim().toLowerCase();
  return normalized === "created" || normalized.endsWith(".created");
}

function applyPromptContextTemplate(
  issueContext: string,
  promptContextTemplate: string,
): string {
  const normalizedTemplate = resolvePromptContextTemplate(promptContextTemplate);

  if (normalizedTemplate.includes(PROMPT_CONTEXT_TEMPLATE_VARIABLE)) {
    return normalizedTemplate.replaceAll(
      PROMPT_CONTEXT_TEMPLATE_VARIABLE,
      issueContext,
    );
  }

  return `${normalizedTemplate}\n\n${issueContext}`.trim();
}

async function writeLinearActivity(params: {
  activityWriter: GatewayActivityWriter;
  agentSessionId: string;
  clientGeneratedId: string;
  content: GatewayAgentActivityContent;
  logger: PluginLogger;
}): Promise<void> {
  try {
    await params.activityWriter.writeActivity({
      agentSessionId: params.agentSessionId,
      clientGeneratedId: params.clientGeneratedId,
      content: params.content,
    });
    noteLinearOutbound();
  } catch (error) {
    noteLinearRuntimeError(
      error instanceof Error ? error.message : String(error),
    );
    params.logger.error(
      `[openclaw-linear] failed to write Linear activity through gateway: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildActivityClientGeneratedId(eventId: string, suffix: string): string {
  return `${eventId}:${suffix}`;
}

async function getSessionMessagesSafe(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  logger: PluginLogger;
}): Promise<unknown[]> {
  try {
    const transcript = await params.runtime.subagent.getSessionMessages({
      sessionKey: params.sessionKey,
      limit: SESSION_MESSAGE_LIMIT,
    });
    return Array.isArray(transcript.messages) ? transcript.messages : [];
  } catch (error) {
    params.logger.warn(
      `[openclaw-linear] failed to read session transcript: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function settleCompletedRunTranscript(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  previousTranscriptMessages: unknown[];
  activityState: ReturnType<typeof createActivityStreamState>;
  logger: PluginLogger;
  debugTranscriptTrace: boolean;
}): Promise<{
  messages: unknown[];
  state: ReturnType<typeof createActivityStreamState>;
}> {
  let currentMessages = params.previousTranscriptMessages;
  let currentState = params.activityState;

  if (currentState.latestAssistantText) {
    return {
      messages: currentMessages,
      state: currentState,
    };
  }

  for (
    let attempt = 1;
    attempt <= FINAL_TRANSCRIPT_SETTLE_ATTEMPTS && !currentState.latestAssistantText;
    attempt += 1
  ) {
    params.logger.debug?.(
      `[openclaw-linear] waiting for final transcript flush (attempt ${attempt}/${FINAL_TRANSCRIPT_SETTLE_ATTEMPTS})`,
    );
    await sleep(FINAL_TRANSCRIPT_SETTLE_DELAY_MS);

    const nextMessages = await getSessionMessagesSafe({
      runtime: params.runtime,
      sessionKey: params.sessionKey,
      logger: params.logger,
    });
    const delta = diffTranscriptMessages(currentMessages, nextMessages);
    currentMessages = nextMessages;
    logTranscriptTrace(params.logger, params.debugTranscriptTrace, "run:settle", {
      sessionKey: params.sessionKey,
      attempt,
      deltaCount: delta.messages.length,
      delta: describeTranscriptMessages(delta.messages, delta.offset),
    });
    currentState = syncTranscriptActivities(
      delta.messages,
      currentState,
      delta.offset,
    ).state;
  }

  return {
    messages: currentMessages,
    state: currentState,
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function logTranscriptTrace(
  logger: PluginLogger,
  enabled: boolean,
  phase: string,
  payload: Record<string, unknown>,
): void {
  if (!enabled) {
    return;
  }

  logger.info(
    `[openclaw-linear][trace] ${phase} ${JSON.stringify(payload)}`,
  );
}

function shortenForLog(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}
