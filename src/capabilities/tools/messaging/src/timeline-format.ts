import { summarizeAudioText } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { StoredConversationMessage } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import { normalizeSystemNoticeText } from "../../../../contexts/conversation-hub/src/application/message-runtime.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import { messagingSystemPromptMessages, messagingToolText } from "../profile.js";
import { escapeXml } from "./send-utils.js";
import type { ShellSwitchContextEntry, VoiceCallTranscriptRow } from "./types.js";

type ChatContextEntry =
  | { kind: "message"; time: Date; message: StoredConversationMessage }
  | ShellSwitchContextEntry;

export function formatCheckChatMessages(
  messages: StoredConversationMessage[],
  options: {
    shellEvents?: ShellSwitchContextEntry[];
    timeZone: string;
    userName: string;
  }
): string {
  return messages.length > 0 || (options.shellEvents?.length ?? 0) > 0
    ? formatTimelineBlocks(messages, options.shellEvents ?? [], options.timeZone, options.userName)
    : messagingToolText.nothingNew;
}

export function formatTimelineBlocks(
  messages: StoredConversationMessage[],
  shellEvents: ShellSwitchContextEntry[],
  timeZone: string,
  userName: string
): string {
  const entries: ChatContextEntry[] = [
    ...messages.map((message) => ({ kind: "message" as const, time: parseMessageTime(message.createdAt, timeZone), message })),
    ...shellEvents
  ].sort((left, right) => left.time.getTime() - right.time.getTime());
  return formatTimelineEntries(entries, timeZone, userName);
}

function formatTimelineEntries(entries: ChatContextEntry[], timeZone: string, userName: string): string {
  const blocks: string[] = [];
  let currentLines: string[] = [];
  let currentTime: Date | undefined;
  let activeCall: { sessionId: string; lines: string[]; durationMs?: number; currentSpeaker?: string } | undefined;

  const flushChatBlock = () => {
    if (currentLines.length > 0) {
      blocks.push(currentLines.join("\n"));
      currentLines = [];
      currentTime = undefined;
    }
  };
  const flushActiveCall = () => {
    if (activeCall) {
      activeCall.lines.push("</voice-call-transcript>");
      blocks.push(activeCall.lines.join("\n"));
      activeCall = undefined;
    }
  };

  for (const entry of entries) {
    if (entry.kind === "message" && isVoiceCallTranscriptMessage(entry.message)) {
      flushChatBlock();
      const transcript = parseVoiceCallTranscriptMessage(entry.message);
      if (!transcript) continue;
      if (!activeCall || activeCall.sessionId !== transcript.sessionId) {
        flushActiveCall();
        activeCall = {
          sessionId: transcript.sessionId,
          durationMs: transcript.durationMs,
          lines: ["<voice-call-transcript>", `[${formatLocalDateTime(entry.time, timeZone)}]`]
        };
      }
      activeCall.durationMs = transcript.durationMs ?? activeCall.durationMs;
      appendVoiceCallTranscriptRow(activeCall, transcript, userName);
      if (transcript.role === "system" && transcript.contentText.trim() === "结束") {
        activeCall.lines.push(`<call-duration>${formatDurationMs(activeCall.durationMs)}</call-duration>`);
        flushActiveCall();
      }
      continue;
    }

    if (activeCall && entry.kind === "message") {
      activeCall.currentSpeaker = undefined;
      activeCall.lines.push(`[message]${formatMessageContentLine(entry.message, userName)}`);
      continue;
    }

    if (activeCall) flushActiveCall();

    if (!currentTime || entry.time.getTime() - currentTime.getTime() >= 5 * 60 * 1000) {
      if (currentLines.length > 0) {
        blocks.push(currentLines.join("\n"));
      }
      currentTime = entry.time;
      currentLines = [`[${formatLocalDateTime(entry.time, timeZone)}]`];
    }
    currentLines.push(formatContextEntryLine(entry, userName));
  }

  flushChatBlock();
  flushActiveCall();
  return blocks.join("\n");
}

function formatContextEntryLine(entry: ChatContextEntry, userName: string): string {
  if (entry.kind === "shell") {
    return messagingToolText.shellSwitch(entry.personalityName, entry.relationshipName);
  }
  return formatMessageContentLine(entry.message, userName);
}

export function appendCurrentTime(output: string, currentTime: string, prefix?: string): string {
  return messagingToolText.appendCurrentTime(output, currentTime, prefix);
}

export function isUnreadUserMessage(message: StoredConversationMessage): boolean {
  return !message.isRead && message.direction === "inbound" && message.senderRole === "user";
}

function formatMessageContentLine(message: StoredConversationMessage, userName: string): string {
  const isSystem = isSystemPromptMessage(message);
  const speaker = message.direction === "outbound" || message.senderRole === "assistant"
      ? formatAssistantSpeaker(message.senderName)
      : userName;
  const recalled = message.isRecalled ? messagingToolText.recalledTag : "";
  const sendStatus = !isSystem && message.direction === "outbound" && message.status === "send_failed"
    ? messagingToolText.sendFailedTag
    : !isSystem && message.direction === "outbound" && message.status === "sending"
      ? messagingToolText.sendingTag
      : "";
  const reactions = summarizeReactions(message.reactionsJson);
  const content = `${message.isRecalled ? messagingToolText.recalledMessage : formatMessageContent(message)}${sendStatus}${reactions ? `[reaction: ${reactions}]` : ""}${recalled}`;
  if (isSystem) return `< system message="${escapeXml(normalizeSystemNoticeText(content))}" />`;
  if (isImageMessage(message)) return `${speaker}: ${content}`;
  if (isMediaActionMessage(message)) return `${speaker}${content}`;
  return content.includes("\n") ? `${speaker}:\n${content}` : `${speaker}:${content}`;
}

function formatAssistantSpeaker(value: string | undefined): string {
  return value === "core" || value === "shell" ? `Alice(${messagingToolText.assistantSpeakerLabels[value]})` : "Alice";
}

function formatMessageContent(message: StoredConversationMessage): string {
  const content = parseContentJson(message.contentJson);
  if (isVoiceCallTranscriptMessage(message)) return message.contentText;
  if (message.contentType === "image" || content?.kind === "image") {
    const imagePath = sandboxAssetPath(optionalStringValue(content?.assetId) || message.contentText);
    return imagePath ? `<image path = "${imagePath}"/>` : messagingToolText.imageMessage;
  }
  if (message.contentType === "audio" || content?.kind === "audio") {
    const transcript = optionalStringValue(content?.transcript) || message.contentText;
    return summarizeAudioText(transcript, message.contentText);
  }
  if (message.contentType === "file" || content?.kind === "file") {
    const filePath = optionalStringValue(content?.filename) || optionalStringValue(content?.assetId) || message.contentText;
    return messagingToolText.fileMessage(filePath);
  }
  return message.contentText;
}

function sandboxAssetPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  if (normalized.startsWith("/")) return normalized;
  if (normalized.startsWith("assets/")) return `/${normalized}`;
  return `/assets/${normalized}`;
}

function isVoiceCallTranscriptMessage(message: StoredConversationMessage): boolean {
  const content = parseContentJson(message.contentJson);
  return message.contentType === "voicecalltranscript" || content?.kind === "voicecalltranscript";
}

function isImageMessage(message: StoredConversationMessage): boolean {
  const content = parseContentJson(message.contentJson);
  return message.contentType === "image" || content?.kind === "image";
}

function parseVoiceCallTranscriptMessage(message: StoredConversationMessage): VoiceCallTranscriptRow | undefined {
  const payload = parseContentJson(message.contentJson);
  if (!payload || payload.kind !== "voicecalltranscript") return undefined;
  const role = transcriptRole(payload.role);
  const sessionId = optionalStringValue(payload.talkSessionId) || optionalStringValue(payload.sessionId) || message.conversationId;
  if (!role || !sessionId) return undefined;
  return {
    sessionId,
    entryId: optionalStringValue(payload.entryId),
    role,
    contentText: message.contentText,
    durationMs: numberValue(payload.durationMs)
  };
}

function transcriptRole(value: unknown): VoiceCallTranscriptRow["role"] | undefined {
  return value === "system" || value === "assistant" || value === "user" ? value : undefined;
}

function appendVoiceCallTranscriptRow(
  activeCall: { lines: string[]; currentSpeaker?: string },
  row: VoiceCallTranscriptRow,
  userName: string
): void {
  if (row.role === "system") {
    const text = row.contentText.trim();
    activeCall.currentSpeaker = undefined;
    if (text === "开始") activeCall.lines.push(messagingToolText.voiceCallStarted);
    else if (text === "结束") activeCall.lines.push(messagingToolText.voiceCallEnded);
    else if (text) activeCall.lines.push(text);
    return;
  }

  const speaker = row.role === "assistant" ? "Alice" : userName;
  const lines = row.contentText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return;
  if (activeCall.currentSpeaker !== speaker) {
    activeCall.lines.push(`${speaker}:`);
    activeCall.currentSpeaker = speaker;
  }
  activeCall.lines.push(...lines);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDurationMs(durationMs: number | undefined): string {
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

function isMediaActionMessage(message: StoredConversationMessage): boolean {
  const content = parseContentJson(message.contentJson);
  return message.contentType === "image"
    || content?.kind === "image"
    || message.contentType === "file"
    || content?.kind === "file";
}

function parseContentJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isSystemPromptMessage(message: StoredConversationMessage): boolean {
  if (message.senderRole === "system") return true;
  return messagingSystemPromptMessages.includes(normalizeSystemNoticeText(message.contentText));
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

function formatLocalDateTime(date: Date, timeZone: string): string {
  const values = localDateTimeParts(date, timeZone);
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

type LocalDateTimeStringParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function localDateTimeParts(date: Date, timeZone: string): LocalDateTimeStringParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as LocalDateTimeStringParts;
}

export function parseMessageTime(value: string, timeZone: string): Date {
  return parseZonedIso(value, timeZone);
}
