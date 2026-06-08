import type { TTSConfig, TtsApiPreset } from "../../../channels/tts/src/index.js";
import { createOpenAICompatibleClient } from "../../../contexts/llm-gateway/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import { buildLLMTextVariables } from "../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import { createTtsPlugin, createTtsRemoteAwareVoiceSynthesizer } from "../../../channels/tts/src/index.js";
import { createAsrPlugin } from "../../../channels/asr/src/index.js";
import type { LLMApiPreset } from "../../../contexts/llm-gateway/src/llm-api-profile.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createVoicePluginRuntime(input: {
  config: { tts: TTSConfig };
  time: CurrentTimeProvider;
  promptProfileStore: any;
  sendLLMRequest(request: any): Promise<any>;
  readLLMApiPresets(): LLMApiPreset[];
  appendLog: AppendLog;
}) {
  const ttsConfigPath = "config/plugin/tts/config.json";
  const ttsGenieSynthesizer = createTtsRemoteAwareVoiceSynthesizer({
    ...input.config.tts,
    ttsConfigPath
  }, { appendLog: input.appendLog });
  input.appendLog("info", `tts configured: plugin_config=${ttsConfigPath} remote-aware Genie stream-input fallback=local-genie`);
  const ttsPlugin = createTtsPlugin({
    baseSynthesizer: ttsGenieSynthesizer,
    configPath: ttsConfigPath,
    llmRequestSender: (request) => input.sendLLMRequest(request),
    resolveApiPreset(name) {
      return input.readLLMApiPresets().find((entry) => entry.name === name);
    },
    createLlmClientFromPreset: createTtsLlmClientFromPreset,
    promptVariables: () => buildLLMTextVariables({
      userName: input.promptProfileStore.get().userName,
      time: input.time
    }),
    appendLog: input.appendLog
  });
  const asrPlugin = createAsrPlugin({
    resolveApiPreset(name) {
      return input.readLLMApiPresets().find((entry) => entry.name === name);
    },
    appendLog: input.appendLog
  });

  return {
    ttsConfigPath,
    ttsPlugin,
    asrPlugin
  };
}

function createTtsLlmClientFromPreset(preset: TtsApiPreset, env: Record<string, string | undefined>) {
  const apiKey = preset.apiKey || (preset.apiKeyEnv ? env[preset.apiKeyEnv] : undefined);
  if (!preset.baseURL || !apiKey) return undefined;
  return createOpenAICompatibleClient({
    baseURL: preset.baseURL,
    apiKey,
    model: preset.model,
    temperature: preset.temperature,
    timeoutMs: preset.timeoutMs,
    extraParams: preset.extraParams
  });
}
