import { createApiFoundationRuntime } from "./api-foundation-runtime.js";
import { createApiRuntimeState } from "./api-runtime-state.js";
import { createApiLLMRuntime } from "./api-llm-runtime.js";
import { createApiToolingRuntime } from "./api-tooling-runtime.js";
import { createApiServerStackRuntime } from "../server/api-server-stack-runtime.js";
import { updateEnvFile } from "../server/env-file.js";
import { createApiAgentStackRuntime } from "./api-agent-stack-runtime.js";
import { createApiControlRuntime } from "./api-control-runtime.js";
import { createAgentLoopRuntime } from "../../../contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { createJsonProcessRestartContinuationStore } from "../../../contexts/agent-loop/src/adapters/json-process-restart-continuation-store.js";
import { createPiLLMRelay, type PiRelayCapability } from "../../../contexts/llm-gateway/src/pi-llm-relay.js";
import { createPiPresetSnapshot } from "../../../contexts/llm-gateway/src/pi-preset-adapter.js";
import { createPiWorkerRuntime, createPiWorkerHttpClient } from "../../../contexts/pi-worker/src/index.js";
import { ensureDockerSandboxContainer, recreateDockerSandboxContainer } from "../../../contexts/bash-sandbox/src/index.js";
const path = await import("node:path");
const crypto = await import("node:crypto");

export function createApiRootRuntime() {
  const apiRuntimeState = createApiRuntimeState();
  const agentLoopRuntime = createAgentLoopRuntime();
  const foundation = createApiFoundationRuntime();
  let refreshDefaultToolRegistry: (() => void) | undefined;
  const processRestartContinuationStore = createJsonProcessRestartContinuationStore(
    path.join(foundation.config.memoryFiles.root, "agent-loop", "process-restart-continuation.json")
  );
  const apiLLMRuntime = createApiLLMRuntime({
    config: foundation.config,
    time: foundation.currentTime,
    tokenUsageStore: foundation.tokenUsageStore,
    apiRuntimeState,
    agentLoopRuntime,
    resolvePromptApiPreset: foundation.resolvePromptApiPreset,
    getConversationStartIndex: (sessionId) => apiAgentStackRuntime.talkAgentLoop.getConversationStartIndex(Number(sessionId)),
    buildTalkRuntimeMessages: (sessionId) => apiAgentStackRuntime.talkRuntime.buildNextLoopMessagePatch(sessionId).messages,
    appendLog: foundation.appendLog
  });
  const piRelay = createPiLLMRelay({
    time: foundation.currentTime,
    host: foundation.config.piWorkerConfig.relayHost,
    port: foundation.config.piWorkerConfig.relayPort,
    maxConcurrency: foundation.config.piWorkerConfig.maxConcurrency,
    recordTokenUsageEvent: (event) => apiLLMRuntime.recordTokenUsageEvent(event)
  });
  let piCapability: { token: string; capability: PiRelayCapability } | undefined;
  const workerToken = readOrCreateWorkerToken();
  foundation.config.bashSandbox.piWorker = {
    enabled: true,
    hostDir: path.resolve("memory-files/pi-sessions"),
    containerDir: "/home/alice/.pi-sessions",
    port: foundation.config.piWorkerConfig.workerPort,
    workerToken,
    sandboxCwd: foundation.config.piWorkerConfig.sandboxCwd,
    maxConcurrency: foundation.config.piWorkerConfig.maxConcurrency,
    maxQueueSize: foundation.config.piWorkerConfig.maxQueueSize,
    taskTimeoutSeconds: foundation.config.piWorkerConfig.taskTimeoutSeconds,
    timezone: foundation.config.core.timezone
  };
  const piWorkerClient = createPiWorkerHttpClient({ baseURL: `http://${foundation.config.piWorkerConfig.workerHost}:${foundation.config.piWorkerConfig.workerPort}`, token: workerToken });
  const piWorkerRuntime = createPiWorkerRuntime({
    worker: piWorkerClient,
    ensureWorker: async () => {
      let relayConfigured = false;
      try {
        syncPiWorkerToken();
        relayConfigured = true;
      } catch (error) {
        if (!(error instanceof Error && error.message === "pi_llm_preset_not_found")) throw error;
        foundation.appendLog("warn", "pi preset not configured; Pi Worker starts without relay capability");
      }
      await ensureDockerSandboxContainer(foundation.config.bashSandbox);
      if (relayConfigured) await configurePiWorkerProcess();
    },
    restartWorker: async (reason) => {
      if (piCapability) piRelay.revokeCapability(piCapability.token);
      piCapability = undefined;
      syncPiWorkerToken();
      await configurePiWorkerProcess();
      if (reason !== "config") await recreateDockerSandboxContainer(foundation.config.bashSandbox);
    },
    startupTimeoutMs: foundation.config.piWorkerConfig.workerStartupTimeoutMs,
    reconcileOnStart: true,
    refreshToolRegistry: () => refreshDefaultToolRegistry?.(),
    appendLog: foundation.appendLog,
    prepareModel: async ({ presetName }) => {
      const preset = foundation.readLLMApiPresets().find((entry: { name: string }) => entry.name === (presetName || foundation.config.piWorkerConfig.llmPresetName));
      if (!preset) throw new Error("pi_llm_preset_not_found");
      const snapshot = createPiPresetSnapshot(preset);
      return {
        model: snapshot.model,
        maxTokens: snapshot.maxTokens,
        supportsImage: snapshot.supportsImage,
        reasoning: typeof snapshot.extraParams.reasoning_effort === "string"
          || (snapshot.extraParams.thinking !== undefined && snapshot.extraParams.thinking !== false)
      };
    },
    onInvocationCompleted: async (completion) => {
      const target = completion.messageTarget ?? {};
      const plugin = typeof target.plugin === "string" && target.plugin ? target.plugin : "web-admin";
      const conversationId = typeof target.sessionId === "string" && target.sessionId ? target.sessionId : "default";
      await apiServerStackRuntime.apiCommunicationRuntime.messageRuntime.deliverPiInvocationCompletion({
        plugin,
        conversationId,
        piSessionId: completion.sessionId,
        piInvocationId: completion.invocationId,
        text: completion.text,
        senderName: foundation.config.project.username,
        senderId: typeof target.userId === "string" ? target.userId : undefined,
        accountId: typeof target.accountId === "string" ? target.accountId : undefined,
        channelId: typeof target.channelId === "string" ? target.channelId : undefined,
        userId: typeof target.userId === "string" ? target.userId : undefined
      });
    }
  });
  const apiControlRuntime = createApiControlRuntime({
    config: foundation.config,
    time: foundation.currentTime,
    store: foundation.store,
    getChatAgent: () => apiAgentStackRuntime.chatAgent,
    triggerSleepMemoryInduction: () => apiToolingRuntime.sleepMemoryInductionRuntime.trigger(),
    restartSandbox: async () => {
      await piWorkerRuntime.restart("wake");
    },
    appendLog: foundation.appendLog,
    appendMessageLog: foundation.appendMessageLog
  });
  const apiToolingRuntime = createApiToolingRuntime({
    config: foundation.config,
    time: foundation.currentTime,
    apiContextRuntime: apiControlRuntime.apiContextRuntime,
    apiLLMRuntime,
    apiRuntimeState,
    agentLoopRuntime,
    readLLMApiPresets: foundation.readLLMApiPresets,
    store: foundation.store,
    outputRouter: apiControlRuntime.outputRouter,
    agentState: apiControlRuntime.agentState,
    getDefaultTarget: () => apiControlRuntime.apiContextRuntime.defaultTargetResolver.getDefaultMessagingTarget() as any,
    getGoogleStreetView: () => apiServerStackRuntime.apiCommunicationRuntime.googleStreetView,
    async getWorldWandererStreetViewReferenceImage() {
      const communicationRuntime = apiServerStackRuntime.apiCommunicationRuntime;
      if (!communicationRuntime.worldWandererRuntime.isEnabled()) return undefined;
      const state = communicationRuntime.worldWandererRuntime.getState();
      const streetView = await communicationRuntime.googleStreetView.getStreetViewByCoordinates({
        lat: state.location.lat,
        lng: state.location.lng
      });
      return streetView.filePath;
    },
    sendMemoryFailureNotice: () => apiControlRuntime.outboundNoticeRuntime.sendMemoryFailureNoticeToFeishu(),
    getApprovalService: () => apiServerStackRuntime.apiCommunicationRuntime.approvalService,
    appendLog: foundation.appendLog,
    resolvePromptApiPreset: foundation.resolvePromptApiPreset,
    appendMessageLog: foundation.appendMessageLog,
    piWorkerRuntime
  });
  refreshDefaultToolRegistry = apiToolingRuntime.refreshToolRegistry;
  const apiAgentStackRuntime = createApiAgentStackRuntime({
    config: foundation.config,
    activeLLM: foundation.activeLLM,
    llmConfigRuntime: foundation.llmConfigRuntime,
    outputRouter: apiControlRuntime.outputRouter,
    apiToolingRuntime,
    apiContextRuntime: apiControlRuntime.apiContextRuntime,
    apiLLMRuntime,
    apiRuntimeState,
    agentLoopRuntime,
    store: foundation.store,
    agentState: apiControlRuntime.agentState,
    time: foundation.currentTime,
    resolvePromptApiPreset: foundation.resolvePromptApiPreset,
    appendLog: foundation.appendLog,
    processRestartContinuationStore
  });
  agentLoopRuntime.setRunners({
    prepareChat: ({ event, signal, agentLoopRunSeq }) => apiAgentStackRuntime.chatAgent.prepareEventRun(event, { signal, agentLoopRunSeq }),
    prepareTalk: ({ sessionId, signal, agentLoopRunSeq }) => apiAgentStackRuntime.talkRuntime.prepareReadyAgentLoopSession(sessionId, { signal, agentLoopRunSeq }) as any
  });
  const apiServerStackRuntime = createApiServerStackRuntime({
    config: foundation.config,
    logs: foundation.logs,
    messageLogs: foundation.messageLogs,
    systemLogStore: foundation.systemLogStore,
    serviceLock: foundation.serviceLock,
    time: foundation.currentTime,
    apiRuntimeState,
    agentLoopRuntime,
    apiContextRuntime: apiControlRuntime.apiContextRuntime,
    apiLLMRuntime,
    apiToolingRuntime,
    store: foundation.store,
    outputRouter: apiControlRuntime.outputRouter,
    readLLMApiPresets: foundation.readLLMApiPresets,
    chatAgent: apiAgentStackRuntime.chatAgent,
    talkRuntime: apiAgentStackRuntime.talkRuntime,
    agentState: apiControlRuntime.agentState,
    sleepCocoonEventRuntime: apiControlRuntime.sleepCocoonEventRuntime,
    calendarEventRuntime: apiControlRuntime.calendarEventRuntime,
    llmConfigRuntime: foundation.llmConfigRuntime,
    activeLLM: foundation.activeLLM,
    agentRunIndicatorRuntime: apiAgentStackRuntime.agentRunIndicatorRuntime,
    appendLog: foundation.appendLog,
    appendMessageLog: foundation.appendMessageLog,
    processRestartContinuationStore,
    piRelay,
    piWorkerRuntime
  });

  return {
    start: () => apiServerStackRuntime.start()
  };

  function piPresetSnapshot() {
    const preset = foundation.readLLMApiPresets().find((entry: { name: string }) => entry.name === foundation.config.piWorkerConfig.llmPresetName);
    if (!preset) throw new Error("pi_llm_preset_not_found");
    return createPiPresetSnapshot(preset);
  }

  function syncPiWorkerToken() {
    if (piCapability) return;
    piCapability = piRelay.createCapability({ sandboxId: foundation.config.bashSandbox.containerName, preset: piPresetSnapshot() });
  }

  async function configurePiWorkerProcess() {
    if (!piCapability) throw new Error("pi_relay_capability_missing");
    await piWorkerClient.configure({
      relayUrl: `http://host.docker.internal:${foundation.config.piWorkerConfig.relayPort}/v1`,
      relayToken: piCapability.token
    });
  }

  function readOrCreateWorkerToken(): string {
    const existing = foundation.config.bashSandbox.piWorker?.workerToken;
    if (existing) return existing;
    const fromEnv = process.env.PI_WORKER_TOKEN;
    const token = fromEnv || crypto.randomBytes(32).toString("base64url");
    // Persisted so a live container keeps answering after a host restart.
    updateEnvFile(".env", { PI_WORKER_TOKEN: token });
    return token;
  }
}
