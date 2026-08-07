import { createMessageRuntime } from "../../../contexts/conversation-hub/src/application/ingest-channel-message.js";
import { buildWorldWandererTargetReachedEvent } from "../../../contexts/conversation-hub/src/application/message-event-builders.js";
import { updateEnvFile } from "../../../apps/api/server/env-file.js";
import type { StoredMessageLog } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { defaultMessagingPluginConfigPath, readMessagingPluginConfig } from "../../../capabilities/tools/messaging/src/index.js";

export function createMessageRuntimeRuntime(input: {
  config: any;
  time: any;
  store: any;
  chatAgent: any;
  agentLoopRuntime: any;
  talkRuntime: any;
  agentState: any;
  outputRouter: any;
  isLLMSessionActive(): boolean;
  messagingConfigPath?: string;
  feishu: any;
  wechat: any;
  initiatedBehaviorRunStore: any;
  getAgentInitiatedBehaviorPlans(): any[];
  getDefaultMessagingTarget(): any;
  getSleepCocoonGoodnightEvent(): any;
  getSleepCocoonWakeEvent(): any;
  getCalendarReminderEvent(): any;
  worldWandererRuntime?: { runIdleTransition(input: { delayMs: number }): Promise<{ targetReached?: true } | undefined> | { targetReached?: true } | undefined };
  agentRunIndicator?: { createFreshCard?(): Promise<void> | void; setTyping?(input: { typing: boolean }): Promise<void> | void };
  queueForceWakeEvent(): void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time" | "timeUtc">): StoredMessageLog;
  processRestartContinuationStore?: any;
  piWorkerRuntime?: { wakeIfNeeded(): Promise<void> };
}) {
  return createMessageRuntime({
    getDelayMs: () => input.config.core.inboundDebounceMs,
    startHeartbeatPaused: input.config.core.heartbeatPaused,
    onHeartbeatPausedChange(paused) {
      updateEnvFile(".env", {
        AGENT_HEARTBEAT_PAUSED: String(paused)
      });
      input.config.core.heartbeatPaused = paused;
    },
    time: input.time,
    getProcessNowTarget() {
      return input.getDefaultMessagingTarget();
    },
    store: input.store,
    chatAgent: input.chatAgent,
    agentLoopRuntime: input.agentLoopRuntime,
    talkRuntime: input.talkRuntime,
    agentState: input.agentState,
    outputRouter: input.outputRouter,
    isLLMSessionActive: input.isLLMSessionActive,
    async setTypingIndicator(typingInput) {
      await setAgentRunIndicatorTyping(typingInput.typing);
      if (typingInput.plugin === "feishu") {
        if (typingInput.typing && !isFeishuTypingEmojiEnabled(input.messagingConfigPath)) return;
        await input.feishu.setTyping({
          userId: typingInput.userId,
          channelId: typingInput.channelId,
          sessionId: typingInput.sessionId,
          typing: typingInput.typing
        });
        return;
      }
      if (typingInput.plugin !== "wechat") return;
      await input.wechat.setTyping({
        userId: typingInput.userId ?? typingInput.channelId,
        sessionId: typingInput.sessionId,
        typing: typingInput.typing
      });
    },
    onHeartbeatTick() {
      input.initiatedBehaviorRunStore.finalizeExpiredResponses(input.time.now().date);
      // 后台非阻塞唤起 pi worker: 失败留到下一个 heartbeat 重试。
      void input.piWorkerRuntime?.wakeIfNeeded?.();
    },
    async onIdleTimerTransition(transitionInput) {
      const result = await input.worldWandererRuntime?.runIdleTransition(transitionInput);
      if (!result?.targetReached) return undefined;
      const target = input.getDefaultMessagingTarget();
      if (!target) {
        input.appendLog("warn", "world wanderer target reached event skipped: no default messaging target");
        return undefined;
      }
      return buildWorldWandererTargetReachedEvent(target, input.time);
    },
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    getRandomInitiatedBehaviorTarget() {
      return input.getDefaultMessagingTarget();
    },
    getSleepCocoonGoodnightEvent: input.getSleepCocoonGoodnightEvent,
    getSleepCocoonWakeEvent: input.getSleepCocoonWakeEvent,
    async beforeSleepCocoonWakeSession() {
      await input.agentRunIndicator?.createFreshCard?.();
    },
    getCalendarReminderEvent: input.getCalendarReminderEvent,
    onInboundUserMessage(messageInput) {
      const count = input.initiatedBehaviorRunStore.markRespondedWithin15m({
        sessionId: messageInput.sessionId,
        respondedAt: messageInput.receivedAtUtc ?? messageInput.receivedAt
      });
      if (count > 0) input.appendLog("info", `initiated behavior response marked: session=${messageInput.sessionId} count=${count}`);
    },
    onForceWake() {
      input.queueForceWakeEvent();
    },
    clearLLMSession() {
      input.chatAgent.clearLLMSession("mode_transition");
    },
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog,
    processRestartContinuationStore: input.processRestartContinuationStore,
    downloadInboundAttachment(downloadInput) {
      if (downloadInput.event.source.plugin === "feishu") {
        return input.feishu.downloadInboundAttachment(downloadInput);
      }
      throw new Error(`missing inbound attachment downloader for ${downloadInput.event.source.plugin}`);
    }
  });

  async function setAgentRunIndicatorTyping(typing: boolean): Promise<void> {
    try {
      await input.agentRunIndicator?.setTyping?.({ typing });
    } catch (error) {
      input.appendLog("warn", `agent run indicator typing ${typing ? "start" : "stop"} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isFeishuTypingEmojiEnabled(configPath = defaultMessagingPluginConfigPath): boolean {
  return readMessagingPluginConfig(configPath).feishuTypingEmojiEnabled;
}
