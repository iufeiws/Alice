import { createApiFoundationRuntime } from "./api-foundation-runtime.js";
import { createApiRuntimeState } from "./api-runtime-state.js";
import { createApiLLMRuntime } from "./api-llm-runtime.js";
import { createApiToolingRuntime } from "./api-tooling-runtime.js";
import { createApiServerStackRuntime } from "../server/api-server-stack-runtime.js";
import { createApiAgentStackRuntime } from "./api-agent-stack-runtime.js";
import { createApiControlRuntime } from "./api-control-runtime.js";
import { createAgentLoopRuntime } from "../../../contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { createJsonProcessRestartContinuationStore } from "../../../contexts/agent-loop/src/adapters/json-process-restart-continuation-store.js";
import { createPiLLMRelay } from "../../../contexts/llm-gateway/src/pi-llm-relay.js";
import { createPiPresetSnapshot } from "../../../contexts/llm-gateway/src/pi-preset-adapter.js";
import { createPiSandboxRuntime, createPiWorkerHttpClient } from "../../../contexts/pi-sandbox/src/index.js";
import { ensureDockerSandboxContainer, recreateDockerSandboxContainer } from "../../../contexts/bash-sandbox/src/index.js";
const path = await import("node:path");

export function createApiRootRuntime() {
  const apiRuntimeState = createApiRuntimeState();
  const agentLoopRuntime = createAgentLoopRuntime();
  const foundation = createApiFoundationRuntime();
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
    host: foundation.config.piSandbox.relayHost,
    port: foundation.config.piSandbox.relayPort,
    recordTokenUsageEvent: (event) => apiLLMRuntime.recordTokenUsageEvent(event)
  });
  let piCapability = piRelay.createCapability({ sandboxId: foundation.config.bashSandbox.containerName });
  foundation.config.bashSandbox.piWorker = {
    enabled: true,
    image: foundation.config.bashSandbox.piWorker?.image,
    hostDir: path.resolve("memory-files/pi-sessions"),
    containerDir: "/alice/.agent/pi-sessions",
    port: foundation.config.piSandbox.workerPort,
    relayUrl: `http://host.docker.internal:${foundation.config.piSandbox.relayPort}/v1`,
    relayToken: piCapability.token,
    sandboxCwd: foundation.config.piSandbox.sandboxCwd,
    maxConcurrency: foundation.config.piSandbox.maxConcurrency,
    maxQueueSize: foundation.config.piSandbox.maxQueueSize,
    taskTimeoutSeconds: foundation.config.piSandbox.taskTimeoutSeconds,
    timezone: foundation.config.core.timezone
  };
  const piSandboxRuntime = createPiSandboxRuntime({
    worker: createPiWorkerHttpClient({ baseURL: `http://${foundation.config.piSandbox.workerHost}:${foundation.config.piSandbox.workerPort}` }),
    ensureWorker: () => ensureDockerSandboxContainer(foundation.config.bashSandbox),
    restartWorker: async () => {
      piRelay.revokeCapability(piCapability.token);
      piCapability = piRelay.createCapability({ sandboxId: foundation.config.bashSandbox.containerName });
      foundation.config.bashSandbox.piWorker!.relayToken = piCapability.token;
      await recreateDockerSandboxContainer(foundation.config.bashSandbox);
    },
    startupTimeoutMs: foundation.config.piSandbox.workerStartupTimeoutMs,
    reconcileOnStart: false,
    appendLog: foundation.appendLog,
    prepareSession: async ({ sessionId, presetName }) => {
      const preset = foundation.readLLMApiPresets().find((entry: { name: string }) => entry.name === (presetName || foundation.config.piSandbox.llmPresetName));
      if (!preset || !sessionId) throw new Error("pi_llm_preset_not_found");
      const snapshot = createPiPresetSnapshot(preset);
      piRelay.bindSession({ token: piCapability.token, sessionId, preset: snapshot });
      return {
        model: snapshot.model,
        temperature: snapshot.temperature,
        maxTokens: snapshot.maxTokens,
        extraParams: snapshot.extraParams,
        supportsImage: snapshot.supportsImage,
        reasoning: typeof snapshot.extraParams.reasoning_effort === "string"
          || (snapshot.extraParams.thinking !== undefined && snapshot.extraParams.thinking !== false)
      };
    },
    preparePreviewSession: async ({ sessionId, presetName }) => {
      const preset = foundation.readLLMApiPresets().find((entry: { name: string }) => entry.name === (presetName || foundation.config.piSandbox.llmPresetName));
      if (!preset) throw new Error("pi_llm_preset_not_found");
      const snapshot = createPiPresetSnapshot(preset);
      piRelay.bindSession({ token: piCapability.token, sessionId, preset: snapshot });
      return {
        model: snapshot.model,
        temperature: snapshot.temperature,
        maxTokens: snapshot.maxTokens,
        extraParams: snapshot.extraParams,
        supportsImage: snapshot.supportsImage,
        reasoning: typeof snapshot.extraParams.reasoning_effort === "string"
          || (snapshot.extraParams.thinking !== undefined && snapshot.extraParams.thinking !== false)
      };
    },
    onTerminal: async (session) => {
      const communication = apiServerStackRuntime.apiCommunicationRuntime;
      const target = session.notificationTarget ?? {};
      const source = session.requester ?? {};
      await communication.messageRuntime.ingestEvent({
        id: `pi:${session.sessionId}:${session.status}`,
        source: {
          plugin: typeof source.plugin === "string" ? source.plugin : "web-admin",
          accountId: typeof source.accountId === "string" ? source.accountId : undefined,
          channelId: typeof source.channelId === "string" ? source.channelId : undefined,
          userId: typeof source.userId === "string" ? source.userId : undefined
        },
        externalSession: {
          scope: target.scope === "group" || target.scope === "topic" || target.scope === "admin" || target.scope === "desktop" ? target.scope : "dm",
          sessionId: typeof target.sessionId === "string" ? target.sessionId : ""
        },
        type: session.status === "completed" ? "job.completed" : "job.failed",
        payload: { kind: "text", text: session.terminalResult ?? session.terminalError ?? session.status },
        meta: { receivedAt: session.updatedAt, raw: { piSessionId: session.sessionId } }
      });
      piRelay.releaseSession({ token: piCapability.token, sessionId: session.sessionId });
    }
  });
  const apiControlRuntime = createApiControlRuntime({
    config: foundation.config,
    time: foundation.currentTime,
    store: foundation.store,
    getChatAgent: () => apiAgentStackRuntime.chatAgent,
    triggerSleepMemoryInduction: () => apiToolingRuntime.sleepMemoryInductionRuntime.trigger(),
    restartSandbox: () => piSandboxRuntime.restart("wake"),
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
    piSandboxRuntime
  });
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
    piSandboxRuntime
  });

  return {
    start: () => apiServerStackRuntime.start()
  };
}
