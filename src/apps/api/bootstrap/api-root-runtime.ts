import { createApiFoundationRuntime } from "./api-foundation-runtime.js";
import { createApiRuntimeState } from "./api-runtime-state.js";
import { createApiLLMRuntime } from "../../../contexts/llm-gateway/src/api-llm-runtime.js";
import { createApiToolingRuntime } from "../../../tools/messaging/src/api-tooling-runtime.js";
import { createApiServerStackRuntime } from "../server/api-server-stack-runtime.js";
import { createApiAgentStackRuntime } from "../../../core/agent/src/api-agent-stack-runtime.js";
import { createApiControlRuntime } from "../../../contexts/control-plane/src/application/admin-control-runtime.js";

export function createApiRootRuntime() {
  const apiRuntimeState = createApiRuntimeState();
  const foundation = createApiFoundationRuntime();
  const apiLLMRuntime = createApiLLMRuntime({
    config: foundation.config,
    time: foundation.currentTime,
    tokenUsageStore: foundation.tokenUsageStore,
    apiRuntimeState,
    resolvePromptApiPreset: foundation.resolvePromptApiPreset,
    getConversationStartIndex: (sessionId) => apiAgentStackRuntime.talkAgentLoop.getConversationStartIndex(sessionId),
    buildTalkRuntimeMessages: (sessionId) => apiAgentStackRuntime.talkRuntime.buildNextLoopMessages(sessionId),
    appendLog: foundation.appendLog
  });
  const apiControlRuntime = createApiControlRuntime({
    config: foundation.config,
    time: foundation.currentTime,
    store: foundation.store,
    getCore: () => apiAgentStackRuntime.core,
    triggerSleepMemoryInduction: () => apiToolingRuntime.sleepMemoryInductionRuntime.trigger(),
    appendLog: foundation.appendLog,
    appendMessageLog: foundation.appendMessageLog
  });
  const apiToolingRuntime = createApiToolingRuntime({
    config: foundation.config,
    time: foundation.currentTime,
    apiContextRuntime: apiControlRuntime.apiContextRuntime,
    apiLLMRuntime,
    apiRuntimeState,
    readLLMApiPresets: foundation.readLLMApiPresets,
    store: foundation.store,
    outputRouter: apiControlRuntime.outputRouter,
    agentState: apiControlRuntime.agentState,
    getDefaultTarget: () => apiControlRuntime.apiContextRuntime.defaultTargetResolver.getDefaultMessagingTarget() as any,
    sendMemoryFailureNotice: () => apiControlRuntime.outboundNoticeRuntime.sendMemoryFailureNoticeToFeishu(),
    appendLog: foundation.appendLog,
    resolvePromptApiPreset: foundation.resolvePromptApiPreset,
    appendMessageLog: foundation.appendMessageLog
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
    agentState: apiControlRuntime.agentState,
    time: foundation.currentTime,
    resolvePromptApiPreset: foundation.resolvePromptApiPreset,
    appendLog: foundation.appendLog
  });
  const apiServerStackRuntime = createApiServerStackRuntime({
    config: foundation.config,
    logs: foundation.logs,
    messageLogs: foundation.messageLogs,
    systemLogStore: foundation.systemLogStore,
    serviceLock: foundation.serviceLock,
    time: foundation.currentTime,
    apiRuntimeState,
    apiContextRuntime: apiControlRuntime.apiContextRuntime,
    apiLLMRuntime,
    apiToolingRuntime,
    store: foundation.store,
    outputRouter: apiControlRuntime.outputRouter,
    readLLMApiPresets: foundation.readLLMApiPresets,
    core: apiAgentStackRuntime.core,
    talkRuntime: apiAgentStackRuntime.talkRuntime,
    agentState: apiControlRuntime.agentState,
    sleepCocoonEventRuntime: apiControlRuntime.sleepCocoonEventRuntime,
    llmConfigRuntime: foundation.llmConfigRuntime,
    activeLLM: foundation.activeLLM,
    appendLog: foundation.appendLog,
    appendMessageLog: foundation.appendMessageLog
  });

  return {
    start: () => apiServerStackRuntime.start()
  };
}
