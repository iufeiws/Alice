import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { MessageRuntimeDeps } from "./message-runtime-contracts.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function persistInboundAttachment(event: AgentEvent, deps: MessageRuntimeDeps): AgentEvent | Promise<AgentEvent> {
  if ((event.payload.kind !== "image" && event.payload.kind !== "file") || event.payload.assetId || !event.payload.resource) return event;
  if (!deps.downloadInboundAttachment) throw new Error(`missing inbound attachment downloader for ${event.source.plugin}`);
  const payload = event.payload;
  const resource = event.payload.resource;
  const assetId = inboundAttachmentAssetId(event, deps.chatFilesRoot ?? path.join("assets", "chat_files"));
  const filePath = deps.chatFilesOutputRoot
    ? path.resolve(deps.chatFilesOutputRoot, path.relative(deps.chatFilesRoot ?? path.join("assets", "chat_files"), assetId))
    : path.resolve(assetId);
  return Promise.resolve()
    .then(async () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const stored = await deps.downloadInboundAttachment!({ event, filePath });
      deps.appendLog("info", `inbound ${event.payload.kind} stored: ${event.source.plugin} ${event.source.rawMessageId ?? event.id} -> ${assetId}`);
      return {
        ...event,
        payload: payload.kind === "image"
          ? {
              ...payload,
              assetId,
              resource: undefined
            }
          : {
              ...payload,
              assetId,
              filename: assetId,
              mime: stored?.mime ?? payload.mime ?? resource.mime,
              resource: undefined
            }
      };
    });
}

function inboundAttachmentAssetId(event: AgentEvent, root: string): string {
  const yearMonth = /^\d{4}-\d{2}/.exec(event.meta.receivedAt)?.[0] ?? "unknown-month";
  const resource = event.payload.kind === "image" || event.payload.kind === "file" ? event.payload.resource : undefined;
  const messageId = safeAttachmentFileName(event.source.rawMessageId ?? event.id);
  const originalName = safeAttachmentFileName(resource?.filename);
  const filename = originalName ? `${messageId}-${originalName}` : `${messageId}${attachmentExtension(event)}`;
  return path.join(root, yearMonth, filename).split(path.sep).join("/");
}

function attachmentExtension(event: AgentEvent): string {
  if (event.payload.kind === "file") return "";
  const mime = event.payload.kind === "image" ? event.payload.resource?.mime : undefined;
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".jpg";
}

function safeAttachmentFileName(value: string | undefined): string {
  return (value ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}
