import { createMutableCurrentTimeProvider } from "../../../core/time/src/index.js";
import { createApiLogRuntime } from "./api-log-runtime.js";
import { createApiStorageRuntime } from "../../../packages/storage/src/api-storage-runtime.js";
import { createApiBootstrapRuntime } from "./api-bootstrap-runtime.js";
import { installApiConsoleLogging } from "./console-log-runtime.js";

export function createApiFoundationRuntime() {
  let store: any;
  let systemLogStore: any;
  const currentTime = createMutableCurrentTimeProvider("UTC");
  const apiLogRuntime = createApiLogRuntime({
    time: currentTime,
    getMessageStore: () => store,
    getSystemLogStore: () => systemLogStore
  });
  const appendLog = apiLogRuntime.appendLog;
  const appendMessageLog = apiLogRuntime.appendMessageLog;
  installApiConsoleLogging({ appendLog, formatLogArg: apiLogRuntime.formatLogArg });

  const bootstrap = createApiBootstrapRuntime({ time: currentTime });
  const storageRuntime = createApiStorageRuntime({
    config: bootstrap.config,
    time: currentTime,
    apiLogRuntime
  });
  store = storageRuntime.store;
  systemLogStore = storageRuntime.systemLogStore;

  return {
    currentTime,
    logs: apiLogRuntime.logs,
    messageLogs: apiLogRuntime.messageLogs,
    appendLog,
    appendMessageLog,
    config: bootstrap.config,
    readLLMApiPresets: bootstrap.readLLMApiPresets,
    resolvePromptApiPreset: bootstrap.resolvePromptApiPreset,
    serviceLock: bootstrap.serviceLock,
    activeLLM: bootstrap.activeLLM,
    llmConfigRuntime: bootstrap.llmConfigRuntime,
    store,
    tokenUsageStore: storageRuntime.tokenUsageStore,
    systemLogStore
  };
}
