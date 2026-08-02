import fsp from "node:fs/promises";
import path from "node:path";
import type { VoiceSynthesizer } from "../../../../channels/tts/src/index.js";
import type { AgentOutput } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { sanitizeMessageText, summarizeAudioText } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { InsertOutboundMessageInput } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import type { CurrentTimeRecord } from "../../../../shared/clock/src/index.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import type { MessagingPluginConfig, MessagingToolTarget, SendType } from "./types.js";

const messageDelayMsPerCharacter = 480;
const minMessageDelayMs = 500;
const maxMessageDelayMs = 8_000;

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;"
  }[char]!));
}

export function normalizeSendType(value: unknown): SendType | undefined {
  const text = stringValue(value) || "message";
  if (text === "message" || text === "markdown" || text === "image" || text === "voice" || text === "file") return text;
  return undefined;
}

export function splitSendContentParts(content: string): string[] {
  return content
    .split(/\r?\n|\\r\\n|\\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function filterParentheticalSendContent(content: string): string {
  return content
    .split(/\r?\n|\\r\\n|\\n/g)
    .filter((line) => !containsDsmlMarkup(line))
    .join("\n")
    .replace(/[ \t]*\([^()\r\n]*\)[ \t]*/g, " ")
    .replace(/[ \t]*（[^（）\r\n]*）[ \t]*/g, " ")
    .split(/\r?\n|\\r\\n|\\n/g)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function containsDsmlMarkup(value: string): boolean {
  return /<\s*[｜|]{2}\s*DSML\s*[｜|]{2}/i.test(value);
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

export function normalizeTarget(target: MessagingToolTarget): MessagingToolTarget {
  if (target.plugin !== "feishu") return target;
  const normalizedChannelId = normalizeFeishuChatId(target.channelId);
  const normalizedUserId = normalizedChannelId ? target.userId : normalizeFeishuOpenId(target.userId ?? target.channelId);
  return {
    ...target,
    channelId: normalizedChannelId,
    userId: normalizedUserId
  };
}

function normalizeFeishuChatId(value: string | undefined): string | undefined {
  const unwrapped = unwrapFeishuInternalId(value);
  if (!unwrapped) return undefined;
  return unwrapped.prefixed && !unwrapped.id.startsWith("oc_") ? undefined : unwrapped.id;
}

function normalizeFeishuOpenId(value: string | undefined): string | undefined {
  const unwrapped = unwrapFeishuInternalId(value);
  if (!unwrapped) return undefined;
  return unwrapped.prefixed && unwrapped.id.startsWith("oc_") ? undefined : unwrapped.id;
}

function unwrapFeishuInternalId(value: string | undefined): { id: string; prefixed: boolean } | undefined {
  if (!value) return undefined;
  const match = /^feishu:(?:dm|group):(.+)$/.exec(value);
  return match ? { id: match[1], prefixed: true } : { id: value, prefixed: false };
}

export function renderSendPart(
  target: MessagingToolTarget,
  type: SendType,
  content: string,
  senderName?: string,
  config?: Pick<MessagingPluginConfig, "mapMarkdownLikeToMarkdown">
): { type: SendType; content: string } {
  if (type === "message" && target.plugin === "feishu") {
    if (senderName === "core" || (config?.mapMarkdownLikeToMarkdown && contentLooksLikeMarkdown(content))) {
      return { type: "markdown", content };
    }
  }
  return { type, content };
}

export function contentLooksLikeMarkdown(content: string): boolean {
  // 行首特征：标题、无序/有序列表、引用、代码围栏、分隔线
  if (/^(?:#{1,6})\s+/m.test(content)) return true;
  if (/^\s*(?:[-*+])\s+\S/m.test(content)) return true;
  if (/^\s*\d+[.)]\s+\S/m.test(content)) return true;
  if (/^\s*>\s?/m.test(content)) return true;
  if (/^\s*```/m.test(content)) return true;
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(content)) return true;
  // 行内特征：加粗、行内代码、链接
  if (/\*\*[^*\n]+\*\*/.test(content)) return true;
  if (/`[^`\n]+`/.test(content)) return true;
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(content)) return true;
  return false;
}

export function buildOutput(
  target: MessagingToolTarget,
  type: SendType,
  content: string,
  now: CurrentTimeRecord,
  transcript?: string,
  senderName?: string,
  filename?: string
): AgentOutput {
  return {
    id: createId("tool_out"),
    target: {
      plugin: target.plugin,
      accountId: target.accountId,
      channelId: target.channelId,
      userId: target.userId,
      sessionId: target.sessionId
    },
    content: type === "markdown"
      ? { kind: "markdown", markdown: content }
      : type === "image"
        ? { kind: "image", assetId: content }
        : type === "voice"
          ? { kind: "audio", assetId: content, transcript }
          : type === "file"
            ? { kind: "file", assetId: content, filename: filename ?? path.basename(content) }
            : { kind: "text", text: content },
    meta: {
      createdAt: now.iso,
      createdAtUtc: now.date.toISOString(),
      senderName,
      urgency: "normal",
      allowStreaming: false
    }
  };
}

export async function isImageFile(filePath: string): Promise<boolean> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, "r");
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const magic = header.subarray(0, bytesRead);
    if (magic.length >= 8 && magic.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
    if (magic.length >= 3 && magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff) return true; // JPEG
    if (magic.length >= 4 && magic.subarray(0, 4).toString("ascii") === "GIF8") return true; // GIF
    if (magic.length >= 12 && magic.subarray(0, 4).toString("ascii") === "RIFF" && magic.subarray(8, 12).toString("ascii") === "WEBP") return true; // WEBP
    if (magic.length >= 2 && magic.subarray(0, 2).toString("ascii") === "BM") return true; // BMP
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return isImageExtension(path.extname(filePath));
}

export function isImageExtension(extension: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension.toLowerCase());
}

export function shouldSplitSendContent(config: MessagingPluginConfig, type: SendType, renderedType: SendType): boolean {
  return config.splitMultilineSendChat && renderedType !== "markdown" && type === "message";
}

export function toStoredOutbound(output: AgentOutput): InsertOutboundMessageInput {
  return {
    plugin: output.target.plugin,
    conversationId: output.target.sessionId,
    senderRole: "assistant",
    senderName: output.meta.senderName,
    contentType: output.content.kind,
    contentText: summarizeOutput(output),
    contentJson: JSON.stringify(output.content),
    createdAt: output.meta.createdAt,
    createdAtUtc: output.meta.createdAtUtc
  };
}

export function summarizeOutput(output: AgentOutput): string {
  const content = output.content;
  if (content.kind === "text") return sanitizeMessageText(content.text);
  if (content.kind === "markdown") return content.markdown;
  if (content.kind === "audio") return summarizeAudioText(content.transcript, content.assetId);
  if (content.kind === "image") return content.assetId;
  if (content.kind === "file") return content.filename || content.assetId;
  if (content.kind === "card") return content.card.title;
  return content.kind;
}

export function normalizeSenderName(value: unknown): string | undefined {
  return value === "core" || value === "shell" ? value : undefined;
}

export function normalizeSendError(error: unknown): string {
  const record = isRecord(error) ? error : undefined;
  const response = isRecord(record?.response) ? record.response : undefined;
  const data = isRecord(response?.data) ? response.data : undefined;
  const nestedError = isRecord(data?.error) ? data.error : undefined;
  const code = data?.code ?? record?.code;
  const msg = typeof data?.msg === "string"
    ? data.msg
    : error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  const logId = typeof data?.log_id === "string"
    ? data.log_id
    : typeof nestedError?.log_id === "string"
      ? nestedError.log_id
      : undefined;
  if (code !== undefined || data?.msg) {
    return `Feishu API${code !== undefined ? ` ${String(code)}` : ""}: ${msg}${logId ? ` log_id=${logId}` : ""}`;
  }
  if (response?.status !== undefined) {
    return `HTTP ${String(response.status)}: ${msg}`;
  }
  return msg;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function messageDelayForContent(content: string): number {
  const characterCount = Array.from(content.replace(/\s+/g, "")).length;
  return Math.min(maxMessageDelayMs, Math.max(minMessageDelayMs, characterCount * messageDelayMsPerCharacter));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function missingVoiceSynthesizer(): VoiceSynthesizer {
  return Object.assign(async () => {
    throw new Error("Voice synthesizer is not configured");
  }, {});
}
