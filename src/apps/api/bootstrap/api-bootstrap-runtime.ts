import { loadConfig } from "../../../packages/config/src/index.js";
import { createMutableLLMClient, createStubLLMClient } from "../../../core/llm/src/index.js";
import { acquireSingletonLock } from "../server/singleton-lock.js";
import { loadDotEnv } from "./dotenv-loader.js";
import { createPromptApiPresetStore } from "../../../core/llm/src/llm-api-profile.js";
import { createLLMConfigRuntime } from "../../../core/llm/src/llm-config-runtime.js";

export function createApiBootstrapRuntime(input: { time: { setTimeZone(timeZone: string): void } }) {
  loadDotEnv(".env");
  const config = loadConfig();
  const promptApiPresets = createPromptApiPresetStore(config.memoryFiles.root);
  const serviceLock = acquireSingletonLock(config.memoryFiles.root, "api");
  input.time.setTimeZone(config.core.timezone);
  const activeLLM = createMutableLLMClient(createStubLLMClient());
  const llmConfigRuntime = createLLMConfigRuntime({
    fallbackClient: activeLLM,
    resolvePreset: promptApiPresets.resolvePromptApiPreset
  });

  return {
    config,
    readLLMApiPresets: promptApiPresets.readLLMApiPresets,
    resolvePromptApiPreset: promptApiPresets.resolvePromptApiPreset,
    serviceLock,
    activeLLM,
    llmConfigRuntime
  };
}
