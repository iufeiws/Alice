import type { CurrentTimeProvider } from "../../../../core/time/src/index.js";
import { createId } from "../../../../packages/types/src/index.js";
import { extractSentMessageCreatedAtUtc, extractSentMessageId } from "./sent-message-utils.js";
import type { DefaultMessagingTarget } from "./default-target-runtime.js";

type MessageStoreLike = {
  insertOutboundMessage(input: {
    plugin: string;
    conversationId: string;
    senderRole: string;
    contentType: string;
    contentText: string;
    contentJson: string;
    createdAt: string;
    createdAtUtc?: string;
  }): { id: number };
  markOutboundMessageSent(id: number, externalMessageId: string | undefined, sentAtUtc: string, createdAtUtc?: string): void;
  markOutboundMessageFailed(id: number, failedAt: string, failureReason: string, failedAtUtc?: string): void;
};

type OutputRouterLike = {
  send(output: unknown): Promise<unknown>;
};

type AppendMessageLog = (input: {
  direction: "inbound" | "outbound";
  plugin: string;
  kind: string;
  target?: string;
  sessionId?: string;
  status?: string;
  summary: string;
  error?: string;
}) => unknown;

export function createOutboundNoticeRuntime(input: {
  time: CurrentTimeProvider;
  outputRouter: OutputRouterLike;
  getStore(): MessageStoreLike | undefined;
  getDefaultTarget(): DefaultMessagingTarget | undefined;
  getDefaultFeishuTarget(): DefaultMessagingTarget | undefined;
  appendMessageLog: AppendMessageLog;
}) {
  return {
    sendSystemNoticeToDefaultTarget,
    sendMemoryFailureNoticeToFeishu
  };

  async function sendSystemNoticeToDefaultTarget(text: string): Promise<void> {
    const target = input.getDefaultTarget();
    const store = input.getStore();
    if (!target || !store) return;
    const now = input.time.now();
    const output = {
      id: createId("sleep_notice"),
      target,
      content: { kind: "text" as const, text },
      meta: {
        createdAt: now.iso,
        createdAtUtc: now.date.toISOString(),
        urgency: "normal" as const,
        allowStreaming: false
      }
    };
    const stored = store.insertOutboundMessage({
      plugin: output.target.plugin,
      conversationId: output.target.sessionId,
      senderRole: "system",
      contentType: output.content.kind,
      contentText: text,
      contentJson: JSON.stringify(output.content),
      createdAt: output.meta.createdAt,
      createdAtUtc: output.meta.createdAtUtc
    });
    try {
      const sent = await input.outputRouter.send(output);
      store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), input.time.now().date.toISOString(), extractSentMessageCreatedAtUtc(sent));
      input.appendMessageLog({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "sent",
        summary: text
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failedTime = input.time.now();
      store.markOutboundMessageFailed(stored.id, failedTime.iso, reason, failedTime.date.toISOString());
      input.appendMessageLog({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "send_failed",
        summary: text,
        error: reason
      });
    }
  }

  async function sendMemoryFailureNoticeToFeishu(): Promise<void> {
    const target = input.getDefaultFeishuTarget();
    if (!target) return;
    const text = "-记忆整理大失败-";
    const now = input.time.now();
    const output = {
      id: createId("memory_failure_notice"),
      target,
      content: { kind: "text" as const, text },
      meta: {
        createdAt: now.iso,
        createdAtUtc: now.date.toISOString(),
        urgency: "normal" as const,
        allowStreaming: false
      }
    };
    try {
      await input.outputRouter.send(output);
      input.appendMessageLog({
        direction: "outbound",
        plugin: "feishu",
        kind: "text",
        target: target.channelId ?? target.userId,
        sessionId: target.sessionId,
        status: "sent",
        summary: text
      });
    } catch (error) {
      input.appendMessageLog({
        direction: "outbound",
        plugin: "feishu",
        kind: "text",
        target: target.channelId ?? target.userId,
        sessionId: target.sessionId,
        status: "send_failed",
        summary: text,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
