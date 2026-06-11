import { createWebRtcVoiceRuntime } from "./web-rtc-voice-runtime.js";
import { createChannelPluginRuntime } from "./channel-plugin-runtime.js";
import { createMessageRuntimeRuntime } from "./message-runtime-runtime.js";
import type { StoredMessageLog } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

export function createApiCommunicationRuntime(input: {
  config: any;
  time: any;
  asrPlugin: any;
  voiceSynthesizer: any;
  talkRuntime: any;
  agentLoopRuntime: any;
  readLLMApiPresets(): any[];
  apiContextRuntime: any;
  store: any;
  core: any;
  agentState: any;
  outputRouter: any;
  isLLMSessionActive(): boolean;
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
  let messageRuntime: any;
  const webRtcVoiceRuntime = createWebRtcVoiceRuntime({
    config: input.config,
    time: input.time,
    asrPlugin: input.asrPlugin,
    voiceSynthesizer: input.voiceSynthesizer,
    talkRuntime: input.talkRuntime,
    readLLMApiPresets: input.readLLMApiPresets,
    appendLog: input.appendLog
  });
  const { feishu, wechat } = createChannelPluginRuntime({
    config: input.config,
    appendLog: input.appendLog,
    feishuPairingStore: input.apiContextRuntime.feishuPairingStore,
    wechatStateStore: input.apiContextRuntime.wechatStateStore,
    time: input.time,
    asrPlugin: input.asrPlugin,
    getMessageRuntime: () => messageRuntime
  });

  messageRuntime = createMessageRuntimeRuntime({
    config: input.config,
    time: input.time,
    store: input.store,
    core: input.core,
    agentLoopRuntime: input.agentLoopRuntime,
    talkRuntime: input.talkRuntime,
    agentState: input.agentState,
    outputRouter: input.outputRouter,
    isLLMSessionActive: input.isLLMSessionActive,
    feishu,
    wechat,
    dailyShellStore: input.dailyShellStore,
    initiatedBehaviorRunStore: input.initiatedBehaviorRunStore,
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    getDefaultMessagingTarget: input.getDefaultMessagingTarget,
    getSleepCocoonGoodnightEvent: input.getSleepCocoonGoodnightEvent,
    getSleepCocoonWakeEvent: input.getSleepCocoonWakeEvent,
    queueForceWakeEvent: input.queueForceWakeEvent,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });

  return { webRtcVoiceRuntime, feishu, wechat, messageRuntime };
}
