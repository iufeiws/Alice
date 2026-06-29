import { createWebRtcVoiceRuntime } from "./web-rtc-voice-runtime.js";
import { createChannelPluginRuntime } from "./channel-plugin-runtime.js";
import { createMessageRuntimeRuntime } from "./message-runtime-runtime.js";
import { createWorldWandererRuntime, defaultWorldWandererPluginConfigPath } from "../../../contexts/world-wanderer/src/index.js";
import { createOutfitOnBodyGenerationAttempt } from "../../../contexts/capabilities/src/outfit-on-body-runtime.js";
import type { StoredMessageLog } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

const path = await import("node:path");

export function createApiCommunicationRuntime(input: {
  config: any;
  time: any;
  asrPlugin: any;
  voiceSynthesizer: any;
  talkRuntime: any;
  supportsAudioInput(): boolean;
  agentLoopRuntime: any;
  readLLMApiPresets(): any[];
  apiContextRuntime: any;
  store: any;
  chatAgent: any;
  agentState: any;
  outputRouter: any;
  isLLMSessionActive(): boolean;
  dailyShellStore: any;
  initiatedBehaviorRunStore: any;
  getAgentInitiatedBehaviorPlans(): any[];
  getDefaultMessagingTarget(): any;
  getSleepCocoonGoodnightEvent(): any;
  getSleepCocoonWakeEvent(): any;
  getCalendarReminderEvent(): any;
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
    supportsAudioInput: input.supportsAudioInput,
    readLLMApiPresets: input.readLLMApiPresets,
    appendLog: input.appendLog
  });
  const { feishu, wechat, googleStreetView } = createChannelPluginRuntime({
    config: input.config,
    appendLog: input.appendLog,
    feishuPairingStore: input.apiContextRuntime.feishuPairingStore,
    wechatStateStore: input.apiContextRuntime.wechatStateStore,
    time: input.time,
    asrPlugin: input.asrPlugin,
    getMessageRuntime: () => messageRuntime
  });
  const worldWandererRuntime = createWorldWandererRuntime({
    configPath: defaultWorldWandererPluginConfigPath,
    dbPath: path.join(input.config.memoryFiles.root, "alice.sqlite"),
    googleStreetView,
    now: () => input.time.now().date,
    random: Math.random,
    appendLog: input.appendLog
  });
  const attemptOutfitOnBodyGeneration = createOutfitOnBodyGenerationAttempt({
    config: input.config,
    dailyShellStore: input.dailyShellStore,
    time: input.time,
    promptProfileStore: input.apiContextRuntime.promptProfileStore,
    coreProfileStore: input.apiContextRuntime.coreProfileStore,
    appendLog: input.appendLog
  });

  messageRuntime = createMessageRuntimeRuntime({
    config: input.config,
    time: input.time,
    store: input.store,
    chatAgent: input.chatAgent,
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
    getCalendarReminderEvent: input.getCalendarReminderEvent,
    worldWandererRuntime,
    attemptDailyOutfitOnBodyGeneration: (daily) => attemptOutfitOnBodyGeneration(daily.outfit),
    queueForceWakeEvent: input.queueForceWakeEvent,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });

  return { webRtcVoiceRuntime, feishu, wechat, googleStreetView, worldWandererRuntime, messageRuntime };
}
