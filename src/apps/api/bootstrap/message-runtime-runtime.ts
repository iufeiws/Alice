import { createMessageRuntime } from "../../../contexts/conversation-hub/src/application/ingest-channel-message.js";
import { updateEnvFile } from "../../../apps/api/server/env-file.js";
import type { StoredMessageLog } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

export function createMessageRuntimeRuntime(input: {
  config: any;
  time: any;
  store: any;
  core: any;
  agentLoopRuntime: any;
  talkRuntime: any;
  agentState: any;
  outputRouter: any;
  isLLMSessionActive(): boolean;
  feishu: any;
  wechat: any;
  dailyShellStore: any;
  initiatedBehaviorRunStore: any;
  getAgentInitiatedBehaviorPlans(): any[];
  getDefaultMessagingTarget(): any;
  getSleepCocoonGoodnightEvent(): any;
  getSleepCocoonWakeEvent(): any;
  getCalendarReminderEvent(): any;
  worldWandererRuntime?: { runIdleTransition(input: { delayMs: number }): Promise<unknown> | unknown };
  attemptDailyOutfitOnBodyGeneration?(daily: { outfit: any }): Promise<unknown> | unknown;
  queueForceWakeEvent(): void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time" | "timeUtc">): StoredMessageLog;
}) {
  return createMessageRuntime({
    getDelayMs: () => input.config.core.inboundDebounceMs,
    startHeartbeatPaused: input.config.core.heartbeatPaused,
    onHeartbeatPausedChange(paused) {
      updateEnvFile(".env", {
        AGENT_HEARTBEAT_PAUSED: String(paused),
        AGENT_HEARTBEAT_START_PAUSED: null
      });
      input.config.core.heartbeatPaused = paused;
    },
    time: input.time,
    getProcessNowTarget() {
      return input.getDefaultMessagingTarget();
    },
    store: input.store,
    core: input.core,
    agentLoopRuntime: input.agentLoopRuntime,
    talkRuntime: input.talkRuntime,
    agentState: input.agentState,
    outputRouter: input.outputRouter,
    isLLMSessionActive: input.isLLMSessionActive,
    async setTypingIndicator(typingInput) {
      if (typingInput.plugin === "feishu") {
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
      const daily = input.dailyShellStore.get(input.time.now().date, input.time.timeZone);
      void input.attemptDailyOutfitOnBodyGeneration?.(daily);
      input.initiatedBehaviorRunStore.finalizeExpiredResponses(input.time.now().date);
    },
    async onIdleTimerTransition(transitionInput) {
      await input.worldWandererRuntime?.runIdleTransition(transitionInput);
    },
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    getRandomInitiatedBehaviorTarget() {
      return input.getDefaultMessagingTarget();
    },
    getSleepCocoonGoodnightEvent: input.getSleepCocoonGoodnightEvent,
    getSleepCocoonWakeEvent: input.getSleepCocoonWakeEvent,
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
      input.core.clearLLMSession("mode_transition");
    },
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });
}
