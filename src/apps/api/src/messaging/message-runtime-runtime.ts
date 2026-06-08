import { createMessageRuntime } from "../../../../core/agent/src/message-runtime.js";
import { updateEnvFile } from "../server/env-file.js";
import type { StoredMessageLog } from "../../../../packages/storage/src/sqlite-store.js";

export function createMessageRuntimeRuntime(input: {
  config: any;
  time: any;
  store: any;
  core: any;
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
      input.dailyShellStore.get(input.time.now().date, input.time.timeZone);
      input.initiatedBehaviorRunStore.finalizeExpiredResponses(input.time.now().date);
    },
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    getRandomInitiatedBehaviorTarget() {
      return input.getDefaultMessagingTarget();
    },
    getSleepCocoonGoodnightEvent: input.getSleepCocoonGoodnightEvent,
    getSleepCocoonWakeEvent: input.getSleepCocoonWakeEvent,
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
