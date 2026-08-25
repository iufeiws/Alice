import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { formatErrorNotice } from "../../../../shared/errors/src/index.js";
import type { DefaultMessagingTarget } from "../../../../apps/api/bootstrap/default-target-runtime.js";
import { sendSystemNoticeFromRuntime } from "./message-runtime.js";

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
  processedAt?: string;
  processedBatchId?: string;
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
    await sendSystemNoticeFromRuntime({
      time: input.time,
      store,
      send: (output) => input.outputRouter.send(output),
      appendMessageLog: input.appendMessageLog
    }, {
      target,
      text
    });
  }

  async function sendMemoryFailureNoticeToFeishu(error: unknown): Promise<void> {
    const target = input.getDefaultFeishuTarget();
    const store = input.getStore();
    if (!target || !store) return;
    await sendSystemNoticeFromRuntime({
      time: input.time,
      store,
      send: (output) => input.outputRouter.send(output),
      appendMessageLog: input.appendMessageLog
    }, {
      target,
      text: formatErrorNotice(error)
    });
  }
}
