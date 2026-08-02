import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { MessageRuntimeDeps } from "./message-runtime-contracts.js";

const fs = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");

const defaultChatFilesRoot = path.join("assets", "chat_files");

export function persistInboundAttachment(event: AgentEvent, deps: MessageRuntimeDeps): AgentEvent | Promise<AgentEvent> {
  if ((event.payload.kind !== "image" && event.payload.kind !== "file") || event.payload.assetId || !event.payload.resource) return event;
  if (!deps.downloadInboundAttachment) throw new Error(`missing inbound attachment downloader for ${event.source.plugin}`);
  const payload = event.payload;
  const resource = event.payload.resource;
  const baseAssetId = inboundAttachmentAssetId(event, deps.chatFilesRoot ?? defaultChatFilesRoot);
  const stagedAssetId = `${baseAssetId}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const stagedPath = resolveOutputPath(deps, stagedAssetId);
  return Promise.resolve()
    .then(async () => {
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      try {
        const stored = await deps.downloadInboundAttachment!({ event, filePath: stagedPath });
        const assetId = await resolveCollisionFreeAssetId(deps, baseAssetId, stagedPath);
        fs.renameSync(stagedPath, resolveOutputPath(deps, assetId));
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
      } catch (error) {
        try {
          fs.rmSync(stagedPath, { force: true });
        } catch {
          // 暂存文件清理失败不影响错误上报
        }
        throw error;
      }
    });
}

function resolveCollisionFreeAssetId(deps: MessageRuntimeDeps, baseAssetId: string, stagedPath: string): Promise<string> {
  return fileSha256(stagedPath).then(async (newHash) => {
    const extension = path.extname(baseAssetId);
    const stem = extension ? baseAssetId.slice(0, -extension.length) : baseAssetId;
    let candidate = baseAssetId;
    for (let n = 0; ; n += 1) {
      const candidatePath = resolveOutputPath(deps, candidate);
      if (!fs.existsSync(candidatePath) || (await fileSha256(candidatePath)) === newHash) return candidate;
      candidate = `${stem}_${n + 1}${extension}`;
    }
  });
}

function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function resolveOutputPath(deps: MessageRuntimeDeps, assetId: string): string {
  const root = deps.chatFilesRoot ?? defaultChatFilesRoot;
  const relative = path.relative(path.resolve(root), path.resolve(assetId));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`inbound attachment asset id escapes chat_files root: ${assetId}`);
  }
  return deps.chatFilesOutputRoot
    ? path.resolve(deps.chatFilesOutputRoot, relative)
    : path.resolve(assetId);
}

function inboundAttachmentAssetId(event: AgentEvent, root: string): string {
  const yearMonth = /^\d{4}-\d{2}/.exec(event.meta.receivedAt)?.[0] ?? "unknown-month";
  const resource = event.payload.kind === "image" || event.payload.kind === "file" ? event.payload.resource : undefined;
  const messageId = safeAttachmentFileName(event.source.rawMessageId ?? event.id);
  const originalName = safeAttachmentFileName(resource?.filename);
  const filename = originalName ? originalName : `${messageId}${attachmentExtension(event)}`;
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
