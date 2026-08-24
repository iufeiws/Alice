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
import { createSessionClearCoordinator } from "../../../contexts/llm-session/src/application/session-clear-coordinator.js";
import { createShortMemoryStore } from "../../../contexts/memory/src/short-memory-store.js";
import { createHostShortMemoryFile, createShortMemoryWorker } from "../../../contexts/memory/src/short-memory-worker.js";
import { createPiLLMRelay, type PiRelayCapability } from "../../../contexts/llm-gateway/src/pi-llm-relay.js";
import { createPiPresetSnapshot } from "../../../contexts/llm-gateway/src/pi-preset-adapter.js";
import { createPiWorkerRuntime, createPiWorkerHttpClient, type PiWorkerHealth } from "../../../contexts/pi-worker/src/index.js";
import { ensureDockerSandboxContainer } from "../../../contexts/bash-sandbox/src/index.js";
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
  // 统一 Session Clear 协调器(§6): 宿主映射文件 + 主库(memory-files/alice.sqlite,
  // 与 memory/calendar 现有 store 同一个库) + 串行 Worker, 注入给 Chat/Talk/Memorize。
  const shortMemoryStore = createShortMemoryStore(path.join(foundation.config.memoryFiles.root, "alice.sqlite"));
  const shortMemoryFile = createHostShortMemoryFile({ hostWorkspaceDir: foundation.config.bashSandbox.hostWorkspaceDir });
  const shortMemoryWorker = createShortMemoryWorker({
    file: shortMemoryFile,
    store: shortMemoryStore,
    time: foundation.currentTime
  });
  const sessionClearCoordinator = createSessionClearCoordinator({
    shortMemoryWorker,
    appendLog: foundation.appendLog
  });
  const apiLLMRuntime = createApiLLMRuntime({
    config: foundation.config,
    time: foundation.currentTime,
    tokenUsageStore: foundation.tokenUsageStore,
    apiRuntimeState,
    agentLoopRuntime,
    sessionClearCoordinator,
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
  let piCapability: { token: string; capability: PiRelayCapability; presetFingerprint: string } | undefined;
  let relayGrantedAt = 0;
  const PI_RELAY_AUTHORIZATION_TTL_MS = 8 * 60 * 60 * 1000;
  const workerToken = readOrCreateWorkerToken();
  foundation.config.bashSandbox.piWorker = {
    enabled: true,
    hostDir: path.resolve("memory-files/pi-sessions"),
    containerDir: "/home/alice/.pi-sessions",
    port: foundation.config.piWorkerConfig.workerPort,
    workerToken,
    maxConcurrency: foundation.config.piWorkerConfig.maxConcurrency,
    maxQueueSize: foundation.config.piWorkerConfig.maxQueueSize,
    taskTimeoutSeconds: foundation.config.piWorkerConfig.taskTimeoutSeconds,
    timezone: foundation.config.core.timezone
  };
  const piWorkerClient = createPiWorkerHttpClient({ baseURL: `http://${foundation.config.piWorkerConfig.workerHost}:${foundation.config.piWorkerConfig.workerPort}`, token: workerToken });
  const piWorkerRuntime = createPiWorkerRuntime({
    worker: piWorkerClient,
    refreshAuthorization: refreshPiWorkerAuthorization,
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
      const target = completion.messageTarget;
      const plugin = target && typeof target.plugin === "string" && target.plugin ? target.plugin : undefined;
      const conversationId = target && typeof target.sessionId === "string" && target.sessionId ? target.sessionId : undefined;
      const registeredChannels = apiControlRuntime.outputRouter.listChannels();
      if (!target || !plugin || !conversationId || !registeredChannels.includes(plugin)) {
        foundation.appendLog("error", `pi invocation completion rejected: missing real message target session=${completion.sessionId} invocation=${completion.invocationId} plugin=${plugin ?? "(missing)"} text=${completion.text}`);
        throw new Error("pi_invocation_completion_requires_message_target");
      }
      // 完成投送只带终态短句：Albert 侧走 interrupt-layer 风格的 Alert，
      // 用户侧走 system notice；完整返回文本不进 Core、不投送，需要时由 SubAgent 工具拉取。
      const statusLabel = completion.status.toUpperCase();
      await apiServerStackRuntime.apiCommunicationRuntime.messageRuntime.deliverPiInvocationCompletion({
        plugin,
        conversationId,
        piSessionId: completion.sessionId,
        piInvocationId: completion.invocationId,
        alertText: `<Alert info="SubAgent(${completion.sessionId})-${statusLabel}" />`,
        noticeText: `SubAgent(${completion.sessionId})-${statusLabel}`,
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
    appendLog: foundation.appendLog,
    appendMessageLog: foundation.appendMessageLog,
    // 复用块 2 已创建的主库(alice.sqlite) Short Memory store, 供 prompt-context 变量查询。
    shortMemoryStore
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
    sessionClearCoordinator,
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
    sessionClearCoordinator,
    processRestartContinuationStore,
    appendAlbertMessage: (message) => apiServerStackRuntime.apiCommunicationRuntime.messageRuntime.appendAlbertMessage(message)
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

  /**
   * 懒授权握手(宿主侧): 保证 capability 与当前 preset 一致(指纹比对, 变更时轮换),
   * 并向容器内 worker 下发 relayUrl/relayToken。
   * - 轮换(revoke+新建)只在无 subagent 运行时进行; worker 不可达时视为无运行(undefined)。
   * - reason="call"|"wake" 且授权未过期且 worker 凭证指纹一致时跳过下发(纯懒检查)。
   * - 授权有效期 8 小时; reason="config" 强制下发。
   * - worker 在轮换/重建后仍持旧 token 时, 主进程靠 workerHealth.relayTokenFingerprint
   *   发现失效并在此重新下发(重新注册)。
   */
  async function refreshPiWorkerAuthorization(input: { reason: "wake" | "config" | "call"; force?: boolean; workerHealth?: PiWorkerHealth }): Promise<void> {
    const fingerprint = JSON.stringify(piPresetSnapshot());
    const needsRotation = piCapability !== undefined && piCapability.presetFingerprint !== fingerprint;
    if (input.reason === "wake" || needsRotation) {
      const running = await anyRunningInvocation();
      if (running === true) {
        foundation.appendLog("info", `pi worker authorization update deferred: subagent running (reason=${input.reason})`);
        return;
      }
      // running === undefined → worker 不可达, 没有运行中的 subagent,
      // 正常轮换/下发; worker 的旧 token 由下次调用时的指纹校验发现并重新注册。
    }
    if (needsRotation) {
      piRelay.revokeCapability(piCapability!.token);
      piCapability = undefined;
    }
    if (!piCapability) {
      const created = piRelay.createCapability({ sandboxId: foundation.config.bashSandbox.containerName, preset: piPresetSnapshot() });
      piCapability = { ...created, presetFingerprint: fingerprint };
    }
    const credentialCurrent = input.workerHealth?.relayTokenFingerprint !== undefined
      && input.workerHealth.relayTokenFingerprint === sha256Hex(piCapability.token);
    if ((input.reason === "call" || input.reason === "wake")
      && input.force !== true
      && credentialCurrent
      && relayGrantedAt
      && Date.now() - relayGrantedAt < PI_RELAY_AUTHORIZATION_TTL_MS) return;
    await ensureDockerSandboxContainer(foundation.config.bashSandbox);
    const relayHostname = foundation.config.bashSandbox.piWorker?.relayHostname ?? "172.17.0.1";
    await piWorkerClient.configure({
      relayUrl: `http://${relayHostname}:${foundation.config.piWorkerConfig.relayPort}/v1`,
      relayToken: piCapability.token
    });
    relayGrantedAt = Date.now();
  }

  async function anyRunningInvocation(): Promise<boolean | undefined> {
    try {
      const health = await piWorkerClient.health();
      return health.activeRuns > 0;
    } catch {
      // worker 不可达: 没有运行中的 subagent(不可达 = 进程不在), 返回 undefined。
      return undefined;
    }
  }

  function sha256Hex(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
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
