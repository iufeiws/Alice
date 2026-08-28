import type { LLMMessage } from "../../../llm-gateway/src/index.js";
import type { ToolResult } from "../../../tool-execution/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type LLMCapabilityFlags = {
  supportsImage?: boolean;
  supportsAudio?: boolean;
};

export type ToolFollowupMessagesResult = {
  toolNotices: string[];
  messages: LLMMessage[];
};

export function buildToolFollowupLLMMessages(
  result: ToolResult,
  capabilities: LLMCapabilityFlags = {}
): ToolFollowupMessagesResult {
  const messages: LLMMessage[] = [];
  const toolNotices: string[] = [];
  if (!capabilities.supportsImage) return { toolNotices, messages };

  for (const attachment of result.llmFollowupAttachments ?? []) {
    if (attachment.kind !== "image") continue;
    let bytes: Buffer;
    let mime: string;
    if (attachment.data !== undefined) {
      bytes = Buffer.from(attachment.data, "base64");
      mime = attachment.mime || detectImageMime(bytes) || "image/jpeg";
    } else {
      const filePath = resolveAttachmentPath(attachment.path, attachment.assetId);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      bytes = fs.readFileSync(filePath);
      mime = detectImageMime(bytes) || attachment.mime || mimeForPath(filePath);
    }
    const base64 = bytes.toString("base64");
    if (attachment.toolNotice) toolNotices.push(attachment.toolNotice);
    messages.push({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: `data:${mime};base64,${base64}`
          }
        },
        {
          type: "text",
          text: attachment.followupText || "这是上一步工具返回的图像"
        }
      ]
    });
  }

  return { toolNotices, messages };
}

function resolveAttachmentPath(filePath: string | undefined, assetId: string | undefined): string | undefined {
  if (filePath) return path.resolve(filePath);
  if (assetId) return path.resolve("assets", assetId);
  return undefined;
}

function mimeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

export function detectImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  return undefined;
}
