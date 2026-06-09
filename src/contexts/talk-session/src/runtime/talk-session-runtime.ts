import { createTalkAgentLoopForSession } from "../../../agent-loop/src/application/run-talk-loop.js";
import { summarizeAudioText } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { AliceStore, StoredConversationMessage } from "../../../conversation-hub/src/ports/conversation-store.js";
import type { TalkSegment, TalkSession } from "../adapters/sqlite-talk-session-store.js";
import { createTalkStore } from "../adapters/sqlite-talk-session-store.js";
import { createTalkRuntime } from "../application/talk-session-runtime.js";

const path = await import("node:path");

export function createTalkRuntimeRuntime(input: {
  isActiveTalkLLMSession(sessionId: string): boolean;
  getActiveTalkLLMSessionId(): number | undefined;
  getTalkPromptProfile(): any;
  time: any;
  dailyShellStore: any;
  getAppearanceDescription(): string;
  memoryStore: any;
  diaryStore: any;
  visibleToolNames(profile: any): string[];
  toolPlugins: any[];
  getLLMConfig(): any;
  sendRequest(input: any): Promise<any>;
  createLLMSession(occurredAt: string): number;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: string): void;
  conversationStore: Pick<AliceStore, "upsertInboundMessage" | "listMessagesByCreatedAtRange">;
  agentState?: { setState(state: "calling" | "waiting", options?: { reason?: string }): unknown };
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  let talkRuntime: any;
  const talkAgentLoop = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: input.isActiveTalkLLMSession,
    getActiveTalkLLMSessionId: input.getActiveTalkLLMSessionId,
    isTalkSessionOpen(sessionId) {
      return talkRuntime.store.getSession(sessionId)?.status === "open";
    },
    pendingVoiceOutputCharCount(sessionId) {
      return talkRuntime.store.pendingVoiceOutputCharCount(sessionId);
    },
    getTalkPromptProfile: input.getTalkPromptProfile,
    time: input.time,
    dailyShellStore: input.dailyShellStore,
    getAppearanceDescription: input.getAppearanceDescription,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    buildNextLoopMessages(sessionId) {
      return talkRuntime.buildNextLoopMessages(sessionId);
    },
    visibleToolNames: input.visibleToolNames,
    toolPlugins: input.toolPlugins,
    getLLMConfig: input.getLLMConfig,
    sendRequest: input.sendRequest,
    appendAssistantDelta({ sessionId, outputId, delta }) {
      talkRuntime.appendAssistantDelta({ sessionId, outputId, delta });
    },
    finishAssistantOutput({ sessionId, outputId }) {
      talkRuntime.finishAssistantOutput({ sessionId, outputId });
    },
    onMaxContinuousRounds({ sessionId, rounds }) {
      talkRuntime.noteAgentLoopMaxContinuousRounds({ sessionId, rounds });
    },
    log(level, message) {
      input.appendLog(level, message);
    }
  });

  talkRuntime = createTalkRuntime({
    store: createTalkStore(path.join("data", "talk.sqlite")),
    time: input.time,
    createLLMSession(sessionInput) {
      return input.createLLMSession(sessionInput.occurredAt);
    },
    runAgentLoop: talkAgentLoop.runTalkAgentLoopForSession,
    interruptAgentLoop(sessionId) {
      input.rewriteActiveTalkLLMSessionFromRuntime(sessionId);
      talkAgentLoop.interruptTalkAgentLoop(sessionId);
    },
    onSessionOpened() {
      input.agentState?.setState("calling", { reason: "talk_session_opened" });
    },
    onSessionClosed(sessionId) {
      projectClosedTalkSessionToConversationHub(sessionId, talkRuntime.store, input.conversationStore, input.time);
      input.agentState?.setState("waiting", { reason: "talk_session_closed" });
    }
  });

  return { talkAgentLoop, talkRuntime };
}

export function projectClosedTalkSessionToConversationHub(
  sessionId: string,
  talkStore: ReturnType<typeof createTalkStore>,
  conversationStore: Pick<AliceStore, "upsertInboundMessage" | "listMessagesByCreatedAtRange">,
  time: { now(): { iso: string } }
): void {
  const session = talkStore.getSession(sessionId);
  if (!session) return;
  const segments = talkStore.listSegments(sessionId).filter((segment) => segment.kind !== "interrupt");
  const createdAt = session.endedAt ?? time.now().iso;
  const chatMessages = conversationStore.listMessagesByCreatedAtRange(session.startedAt, createdAt)
    .filter((message) => message.contentType !== "voicecalltranscript");
  const body = buildVoiceCallTranscriptBody(session, segments, chatMessages);
  conversationStore.upsertInboundMessage({
    plugin: session.plugin || "webrtc_voice",
    externalMessageId: `voicecalltranscript:${session.sessionId}`,
    conversationId: session.channelId || session.sessionId,
    senderId: session.userId,
    senderRole: "system",
    contentType: "voicecalltranscript",
    contentText: body,
    contentJson: JSON.stringify({
      kind: "voicecalltranscript",
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      startedAtUtc: session.startedAtUtc,
      endedAt: session.endedAt,
      endedAtUtc: session.endedAtUtc,
      durationMs: callDurationMs(session),
      segmentCount: segments.length,
      chatMessageCount: chatMessages.length
    }),
    createdAt,
    createdAtUtc: session.endedAtUtc,
    lastEventAt: createdAt,
    lastEventAtUtc: session.endedAtUtc,
    coreProcessedAt: createdAt
  });
}

function buildVoiceCallTranscriptBody(session: TalkSession, segments: TalkSegment[], chatMessages: StoredConversationMessage[]): string {
  const entries = [
    ...segments.map((segment, index) => ({
      timeMs: Date.parse(segment.endedAtUtc ?? segment.endedAt),
      order: index,
      line: formatTranscriptSegment(segment)
    })),
    ...chatMessages.map((message, index) => ({
      timeMs: Date.parse(message.createdAtUtc ?? message.createdAt),
      order: segments.length + index,
      line: formatChatMessageSegment(message)
    }))
  ]
    .filter((entry) => entry.line)
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.timeMs) ? left.timeMs : 0;
      const rightTime = Number.isFinite(right.timeMs) ? right.timeMs : 0;
      return leftTime - rightTime || left.order - right.order;
    });
  return [
    "-已接通-",
    ...entries.map((entry) => entry.line),
    "-已挂断-",
    `<call-duration>${formatDuration(callDurationMs(session))}</call-duration>`
  ].join("\n");
}

function formatTranscriptSegment(segment: TalkSegment): string {
  const text = segment.contentText.trim();
  if (!text) return "";
  if (segment.role === "assistant") return `Alice:${text}`;
  return `{{user}}:${text}`;
}

function formatChatMessageSegment(message: StoredConversationMessage): string {
  const line = formatConversationMessageLine(message, "{{user}}").trim();
  return line ? `[message]${line}` : "";
}

function formatConversationMessageLine(message: StoredConversationMessage, userName: string): string {
  const isSystem = isSystemPromptMessage(message);
  const speaker = message.direction === "outbound" || message.senderRole === "assistant"
    ? "Alice"
    : userName;
  const recalled = message.isRecalled ? "[已撤回]" : "";
  const sendStatus = !isSystem && message.direction === "outbound" && message.status === "send_failed"
    ? "[发送失败]"
    : !isSystem && message.direction === "outbound" && message.status === "sending"
      ? "[发送中]"
      : "";
  const reactions = summarizeReactions(message.reactionsJson);
  const content = `${message.isRecalled ? "(message recalled)" : formatConversationMessageContent(message)}${sendStatus}${reactions ? `[reaction: ${reactions}]` : ""}${recalled}`;
  if (isSystem) return content;
  return isMediaActionMessage(message) ? `${speaker}${content}` : `${speaker}:${content}`;
}

function formatConversationMessageContent(message: StoredConversationMessage): string {
  const content = parseJsonObject(message.contentJson);
  if (message.contentType === "image" || content?.kind === "image") return "发送了一张图片";
  if (message.contentType === "audio" || content?.kind === "audio") {
    const transcript = optionalStringValue(content?.transcript) || message.contentText;
    return summarizeAudioText(transcript, message.contentText);
  }
  if (message.contentType === "file" || content?.kind === "file") {
    const filePath = optionalStringValue(content?.filename) || optionalStringValue(content?.assetId) || message.contentText;
    return `发送了文件[${filePath}]`;
  }
  return message.contentText;
}

function isMediaActionMessage(message: StoredConversationMessage): boolean {
  const content = parseJsonObject(message.contentJson);
  return message.contentType === "image"
    || content?.kind === "image"
    || message.contentType === "file"
    || content?.kind === "file";
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isSystemPromptMessage(message: StoredConversationMessage): boolean {
  if (message.senderRole === "system") return true;
  return [
    "-少女拍照中-",
    "-大失败-",
    "-星界信号丢失-",
    "(少女拍照中...)",
    "(大失败...)"
  ].includes(message.contentText);
}

function summarizeReactions(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, { count?: unknown }>;
    return Object.entries(parsed)
      .map(([emoji, value]) => `${emoji}:${typeof value.count === "number" ? value.count : 0}`)
      .filter((part) => !part.endsWith(":0"))
      .join(", ");
  } catch {
    return "";
  }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function callDurationMs(session: TalkSession): number | undefined {
  const start = session.startedAtUtc ? Date.parse(session.startedAtUtc) : Date.parse(session.startedAt);
  const end = session.endedAtUtc ? Date.parse(session.endedAtUtc) : (session.endedAt ? Date.parse(session.endedAt) : NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "unknown";
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
