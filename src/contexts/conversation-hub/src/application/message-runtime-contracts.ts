import type { AgentEvent, AgentOutput } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { AgentLoopRuntime, PreparedAgentLoopRun } from "../../../agent-loop/src/runtime/agent-loop-runtime.js";
import type { LLMSessionClearReason } from "../../../agent-loop/src/application/chat-agent-types.js";
import type { AgentStateController } from "../../../../contexts/agent-loop/src/domain/agent-loop-state.js";
import type { AgentInitiatedBehaviorPlan } from "../../../../contexts/initiative/src/domain/initiated-behavior.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ProcessRestartContinuationStore } from "../../../agent-loop/src/adapters/json-process-restart-continuation-store.js";
import type { ControlCommandRuntime } from "../../../control-command/src/index.js";
import type {
  InsertOutboundMessageInput,
  StoredConversationMessage,
  StoredMessageLog,
  UpdateMessageReactionInput,
  UpsertBothMessageInput,
  UpsertInboundMessageInput
} from "../../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

export type MessageRuntimeDeps = {
  getDelayMs(): number;
  formatPendingBatch?(messages: StoredConversationMessage[]): string;
  getHeartbeatIntervalMs?: () => number;
  startHeartbeatPaused?: boolean;
  onHeartbeatTick?: () => void;
  onIdleTimerTransition?: (input: { delayMs: number }) => Promise<AgentEvent | undefined> | AgentEvent | undefined;
  getSleepCocoonGoodnightEvent?: () => AgentEvent | undefined;
  getSleepCocoonWakeEvent?: () => AgentEvent | undefined;
  getSleepCocoonMorningEvent?: () => AgentEvent | undefined;
  beforeSleepCocoonWakeSession?: (event: AgentEvent) => Promise<void> | void;
  getCalendarReminderEvent?: () => AgentEvent | undefined;
  getAgentInitiatedBehaviorPlans?: () => AgentInitiatedBehaviorPlan[];
  getRandomInitiatedBehaviorTarget?: () => {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
  } | undefined;
  controlCommandRuntime?: ControlCommandRuntime;
  onInboundUserMessage?: (input: { sessionId: string; receivedAt: string; receivedAtUtc?: string }) => void;
  clearLLMSession(reason: LLMSessionClearReason): void | Promise<void>;
  isLLMSessionActive?: () => boolean;
  agentLoopRuntime?: AgentLoopRuntime;
  talkRuntime?: {
    markAgentLoopReady?(sessionId: number): void;
    claimReadyAgentLoopSession?(): number | undefined;
    prepareReadyAgentLoopSession?(sessionId: number, options?: { signal?: AbortSignal; agentLoopRunSeq?: number }): Promise<PreparedAgentLoopRun | undefined> | PreparedAgentLoopRun | undefined;
  };
  setTypingIndicator?(input: {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
    typing: boolean;
  }): Promise<void>;
  getProcessNowTarget?(): {
    plugin: string;
    accountId?: string;
    channelId?: string;
    userId?: string;
    sessionId: string;
  } | undefined;
  now?: () => Date;
  time?: CurrentTimeProvider;
  random?: () => number;
  store: {
    insertMessageLog(input: Omit<StoredMessageLog, "id">): StoredMessageLog;
    upsertInboundMessage(input: UpsertInboundMessageInput): StoredConversationMessage;
    upsertBothMessage(input: UpsertBothMessageInput): StoredConversationMessage;
    insertOutboundMessage(input: InsertOutboundMessageInput): StoredConversationMessage;
    listMessages(limit: number): StoredConversationMessage[];
    listMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
    listUnprocessedCoreMessagesForConversation(conversationId: string, limit: number): StoredConversationMessage[];
    listPendingCoreConversations(): Array<{ conversationId: string }>;
    markMessagesCoreProcessed(ids: number[], processedAt: string, batchId: string): void;
    markOutboundMessageSent(id: number, externalMessageId: string | undefined, sentAtUtc: string, createdAtUtc?: string): void;
    markOutboundMessageFailed(id: number, failedAt: string, failureReason: string, failedAtUtc?: string): void;
    markMessageRead(plugin: string, externalMessageId: string, readAt: string, readAtUtc?: string): boolean;
    markMessageRecalled(plugin: string, externalMessageId: string, recalledAt: string, recalledAtUtc?: string): boolean;
    updateMessageReaction(input: UpdateMessageReactionInput): boolean;
  };
  chatAgent: {
    prepareEventRun(event: AgentEvent, options?: { agentLoopRunSeq?: number; appendSessionContextAfterFailedRequest?: boolean }): Promise<PreparedAgentLoopRun | AgentOutput[]> | PreparedAgentLoopRun | AgentOutput[];
  };
  agentState?: Pick<
    AgentStateController,
    "canReplyToInbound" | "canRunHeartbeat" | "getInboundDelayMs" | "tick"
  > & Partial<Pick<AgentStateController, "getSnapshot" | "noteInboundMessage" | "noteInboundProcessed" | "onChange" | "onTransition" | "setState" | "waitForWake">>;
  outputRouter: {
    sendAll(outputs: AgentOutput[]): Promise<unknown>;
  };
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time" | "timeUtc">): StoredMessageLog;
  downloadInboundAttachment?(input: { event: AgentEvent; filePath: string }): Promise<{ filename?: string; mime?: string } | void>;
  chatFilesRoot?: string;
  chatFilesOutputRoot?: string;
  onHeartbeatPausedChange?: (paused: boolean) => void;
  processRestartContinuationStore?: ProcessRestartContinuationStore;
};

export type SystemNoticeTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type SendSystemNoticeInput = {
  target: SystemNoticeTarget;
  text: string;
  writeLog?: boolean;
};

export type AppendAlbertMessageInput = {
  callId: string;
  requester?: AgentEvent["source"];
  externalSession?: AgentEvent["externalSession"];
  contentText: string;
};

/**
 * Deliver a Pi invocation completion as one logical `both` message: it enters
 * the Alice conversation/Core pending queue as an Albert user message and is
 * also sent to the invocation's original message target as a system notice.
 * The full invocation result is never written to Core nor sent to the user;
 * the Albert side only carries `alertText` (interrupt-layer-style Alert) and
 * the user side only carries `noticeText` (a short terminal-status notice).
 * `accountId`/`channelId`/`userId` come from the invocation-saved target and
 * are required for channel senders (e.g. Feishu) to resolve the receive id.
 */
export type DeliverPiInvocationCompletionInput = {
  plugin: string;
  conversationId: string;
  piSessionId: string;
  piInvocationId: string;
  /** Albert 侧消息正文：进入 Core 队列的 Alert 文本，如 `<Alert info="SubAgent(s)-COMPLETED" />`。 */
  alertText: string;
  /** 用户侧 system notice 原文：短句，发送时按规则化输出包裹，如 `SubAgent(s)-COMPLETED`。 */
  noticeText: string;
  senderName?: string;
  senderId?: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
};

export type MessageRuntime = {
  ingestEvent(event: AgentEvent): Promise<void>;
  ingestLifecycle(event: MessageLifecycleEvent): void;
  appendAlbertMessage(input: AppendAlbertMessageInput): void;
  sendSystemNotice(input: SendSystemNoticeInput): Promise<void>;
  deliverPiInvocationCompletion(input: DeliverPiInvocationCompletionInput): Promise<void>;
  noteMessagesPolled(sessionId: string): void;
  recoverProcessRestartContinuation(): Promise<void>;
  pauseHeartbeat(): void;
  resumeHeartbeat(): void;
  processNow(): Promise<void>;
  getStatus(): {
    heartbeatPaused: boolean;
    pendingSessions: string[];
    processingSessions: string[];
    heartbeatScheduled: boolean;
  };
  flushAll(): Promise<void>;
};

export type MessageLifecycleEvent =
  | {
      kind: "reaction.created" | "reaction.deleted";
      plugin: string;
      externalEventId?: string;
      externalMessageId: string;
      conversationId?: string;
      actorId?: string;
      emoji: string;
      occurredAt: string;
      occurredAtUtc?: string;
      raw?: unknown;
    }
  | {
      kind: "message.read" | "message.recalled";
      plugin: string;
      externalEventId?: string;
      externalMessageId: string;
      conversationId?: string;
      actorId?: string;
      occurredAt: string;
      occurredAtUtc?: string;
      raw?: unknown;
    };
