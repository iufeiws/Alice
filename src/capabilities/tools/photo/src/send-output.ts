import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { AliceStore, InsertOutboundMessageInput } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import type { AgentOutput } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import type { PhotoToolTarget } from "./selfie-tool.js";

export type PhotoSendDeps = {
  store: Pick<AliceStore, "insertOutboundMessage" | "markOutboundMessageSent" | "markOutboundMessageFailed">;
  outputRouter: Pick<OutputRouter, "send">;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog?(input: {
    direction: "outbound";
    plugin: string;
    kind: string;
    target?: string;
    sessionId?: string;
    status?: string;
    summary: string;
    error?: string;
  }): unknown;
};

export async function sendText(deps: PhotoSendDeps, time: CurrentTimeProvider, target: PhotoToolTarget, text: string, senderRole: "assistant" | "system" = "assistant"): Promise<unknown> {
  const now = time.now();
  return sendOutput(deps, time, {
    id: createId("tool_out"),
    target: {
      plugin: target.plugin,
      accountId: target.accountId,
      channelId: target.channelId,
      userId: target.userId,
      sessionId: target.sessionId
    },
    content: { kind: "text", text },
    meta: {
      createdAt: now.iso,
      createdAtUtc: now.date.toISOString(),
      urgency: "normal",
      allowStreaming: false
    }
  }, senderRole);
}

export async function sendImage(deps: PhotoSendDeps, time: CurrentTimeProvider, target: PhotoToolTarget, assetId: string): Promise<unknown> {
  const now = time.now();
  return sendOutput(deps, time, {
    id: createId("tool_out"),
    target: {
      plugin: target.plugin,
      accountId: target.accountId,
      channelId: target.channelId,
      userId: target.userId,
      sessionId: target.sessionId
    },
    content: { kind: "image", assetId },
    meta: {
      createdAt: now.iso,
      createdAtUtc: now.date.toISOString(),
      urgency: "normal",
      allowStreaming: false
    }
  });
}

export async function sendSelfieFailureNotice(deps: PhotoSendDeps, time: CurrentTimeProvider, target: PhotoToolTarget): Promise<void> {
  try {
    await sendText(deps, time, target, "-大失败-", "system");
  } catch (error) {
    deps.appendLog?.("warn", `selfie failure notice failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function sendOutput(deps: PhotoSendDeps, time: CurrentTimeProvider, output: AgentOutput, senderRole: "assistant" | "system" = "assistant"): Promise<unknown> {
  const stored = deps.store.insertOutboundMessage(toStoredOutbound(output, senderRole));
  try {
    const sent = await deps.outputRouter.send(output);
    deps.store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), time.now().date.toISOString(), extractSentMessageCreatedAtUtc(sent));
    deps.appendMessageLog?.({
      direction: "outbound",
      plugin: output.target.plugin,
      kind: output.content.kind,
      target: output.target.channelId ?? output.target.userId,
      sessionId: output.target.sessionId,
      status: "sent",
      summary: summarizeOutput(output)
    });
    return sent;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failedTime = time.now();
    deps.store.markOutboundMessageFailed(stored.id, failedTime.iso, reason, failedTime.date.toISOString());
    deps.appendMessageLog?.({
      direction: "outbound",
      plugin: output.target.plugin,
      kind: output.content.kind,
      target: output.target.channelId ?? output.target.userId,
      sessionId: output.target.sessionId,
      status: "send_failed",
      summary: summarizeOutput(output),
      error: reason
    });
    throw error;
  }
}

export function extractSentMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { messageId?: unknown };
  return typeof record.messageId === "string" ? record.messageId : undefined;
}

function toStoredOutbound(output: AgentOutput, senderRole: "assistant" | "system" = "assistant"): InsertOutboundMessageInput {
  return {
    plugin: output.target.plugin,
    conversationId: output.target.sessionId,
    senderRole,
    contentType: output.content.kind,
    contentText: summarizeOutput(output),
    contentJson: JSON.stringify(output.content),
    createdAt: output.meta.createdAt,
    createdAtUtc: output.meta.createdAtUtc
  };
}

function summarizeOutput(output: AgentOutput): string {
  const content = output.content;
  if (content.kind === "image" || content.kind === "audio") return content.assetId;
  if (content.kind === "file") return content.filename || content.assetId;
  if (content.kind === "text") return content.text;
  if (content.kind === "markdown") return content.markdown;
  if (content.kind === "card") return content.card.title;
  return content.kind;
}

function extractSentMessageCreatedAtUtc(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { createdAtUtc?: unknown };
  return typeof record.createdAtUtc === "string" ? record.createdAtUtc : undefined;
}
