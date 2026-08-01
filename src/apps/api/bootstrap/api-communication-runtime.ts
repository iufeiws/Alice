import { createWebRtcVoiceRuntime } from "./web-rtc-voice-runtime.js";
import { createChannelPluginRuntime } from "./channel-plugin-runtime.js";
import { createMessageRuntimeRuntime } from "./message-runtime-runtime.js";
import { createWorldWandererRuntime, defaultWorldWandererPluginConfigPath } from "../../../contexts/world-wanderer/src/index.js";
import { createFeishuDynamicCardAgentRunIndicator, createFeishuToolExecutionReporter, createJsonFeishuAgentRunIndicatorCardStore } from "../../../contexts/agent-run-indicator/src/index.js";
import { setLLMToolExecutionReporter } from "../../../contexts/llm-gateway/src/llm-tool-loop.js";
import { isFeishuConfigured } from "../../../channels/feishu/src/config.js";
import type { StoredMessageLog } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createFeishuApprovalService } from "../../../contexts/approval/src/index.js";

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
  initiatedBehaviorRunStore: any;
  getAgentInitiatedBehaviorPlans(): any[];
  getDefaultMessagingTarget(): any;
  getSleepCocoonGoodnightEvent(): any;
  getSleepCocoonWakeEvent(): any;
  getCalendarReminderEvent(): any;
  queueForceWakeEvent(): void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: Omit<StoredMessageLog, "id" | "time" | "timeUtc">): StoredMessageLog;
  processRestartContinuationStore?: any;
  recognizeImage(filePath: string): Promise<any>;
}) {
  let messageRuntime: any;
  let approvalService: ReturnType<typeof createFeishuApprovalService>;
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
    getMessageRuntime: () => messageRuntime,
    onFeishuCardAction: async (event) => await approvalService.handleCardAction(event),
    recognizeImage: input.recognizeImage
  });
  approvalService = createFeishuApprovalService({
    client: feishu.agentRunCardClient,
    pairingStore: input.apiContextRuntime.feishuPairingStore
  });
  const agentRunIndicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => isFeishuConfigured(input.config.plugins.feishu),
    client: feishu.agentRunCardClient,
    pairingStore: input.apiContextRuntime.feishuPairingStore,
    cardStore: createJsonFeishuAgentRunIndicatorCardStore(path.join(input.config.memoryFiles.root, "indexes", "feishu-agent-run-indicator-card.json")),
    time: input.time,
    getState: () => input.agentState.getSnapshot(),
    log: input.appendLog
  });
  void agentRunIndicator.ensureReady?.().catch((error: unknown) => {
    input.appendLog("warn", `agent run indicator ensure failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const toolExecutionReporter = createFeishuToolExecutionReporter({
    client: feishu.agentRunCardClient,
    pairingStore: input.apiContextRuntime.feishuPairingStore,
    log: input.appendLog
  });
  input.outputRouter.onSent(async (output: { target: { plugin: string } }) => {
    input.agentState.restartInactivityTimer();
    if (output.target.plugin === "feishu") await toolExecutionReporter.endSequence();
  });
  setLLMToolExecutionReporter(toolExecutionReporter);
  const worldWandererRuntime = createWorldWandererRuntime({
    configPath: defaultWorldWandererPluginConfigPath,
    dbPath: path.join(input.config.memoryFiles.root, "alice.sqlite"),
    googleStreetView,
    now: () => input.time.now().date,
    random: Math.random,
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
    initiatedBehaviorRunStore: input.initiatedBehaviorRunStore,
    getAgentInitiatedBehaviorPlans: input.getAgentInitiatedBehaviorPlans,
    getDefaultMessagingTarget: input.getDefaultMessagingTarget,
    getSleepCocoonGoodnightEvent: input.getSleepCocoonGoodnightEvent,
    getSleepCocoonWakeEvent: input.getSleepCocoonWakeEvent,
    getCalendarReminderEvent: input.getCalendarReminderEvent,
    worldWandererRuntime,
    agentRunIndicator,
    queueForceWakeEvent: input.queueForceWakeEvent,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog,
    processRestartContinuationStore: input.processRestartContinuationStore
  });

  return { webRtcVoiceRuntime, feishu, wechat, googleStreetView, worldWandererRuntime, messageRuntime, agentRunIndicator, approvalService };
}
