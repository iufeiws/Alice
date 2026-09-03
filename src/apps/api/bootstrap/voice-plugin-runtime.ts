import type { TTSConfig, TtsApiPreset, TtsLlmClient } from "../../../channels/tts/src/index.js";
import type { PromptContextRuntime } from "../../../contexts/prompt-context/src/index.js";
import { createTtsPlugin, createTtsRemoteAwareVoiceSynthesizer } from "../../../channels/tts/src/index.js";
import { createAsrPlugin } from "../../../channels/asr/src/index.js";
import { createLLMClientFromPreset, type LLMApiPreset } from "../../../contexts/llm-gateway/src/llm-api-profile.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createVoicePluginRuntime(input: {
  config: { project: { username: string }; tts: TTSConfig };
  promptContextRuntime: PromptContextRuntime;
  sendLLMRequest(request: any): Promise<any>;
  readLLMApiPresets(): LLMApiPreset[];
  recordTokenUsageEvent(event: any): void;
  appendLog: AppendLog;
}) {
  const ttsConfigPath = "config/plugin/tts/config.json";
  const ttsGenieSynthesizer = createTtsRemoteAwareVoiceSynthesizer({
    ...input.config.tts,
    ttsConfigPath
  }, { appendLog: input.appendLog });
  input.appendLog("info", `tts configured: plugin_config=${ttsConfigPath} remote-aware Genie synthesize fallback=local-genie`);
  const ttsPlugin = createTtsPlugin({
    baseSynthesizer: ttsGenieSynthesizer,
    configPath: ttsConfigPath,
    llmRequestSender: (request) => input.sendLLMRequest(request),
    resolveApiPreset(name) {
      return input.readLLMApiPresets().find((entry) => entry.name === name);
    },
    createLlmClientFromPreset: createTtsLlmClientFromPreset,
    recordTokenUsageEvent: input.recordTokenUsageEvent,
    promptRenderer: () => input.promptContextRuntime,
    appendLog: input.appendLog
  });
  const asrPlugin = createAsrPlugin({
    llmRequestSender: (request) => input.sendLLMRequest(request),
    promptRenderer: () => input.promptContextRuntime,
    resolveApiPreset(name) {
      return input.readLLMApiPresets().find((entry) => entry.name === name);
    },
    createLlmClientFromPreset: createAsrLlmClientFromPreset,
    appendLog: input.appendLog
  });

  return {
    ttsConfigPath,
    ttsPlugin,
    asrPlugin
  };
}

function createAsrLlmClientFromPreset(preset: TtsApiPreset) {
  return createLLMClientFromPreset(preset);
}

function createTtsLlmClientFromPreset(preset: TtsApiPreset) {
  const client = createLLMClientFromPreset(preset);
  if (!client) return undefined;
  return {
    async chat(input) {
      const result = await client.chat(input);
      return {
        message: {
          role: result.message.role,
          content: typeof result.message.content === "string" ? result.message.content : ""
        }
      };
    }
  } satisfies TtsLlmClient;
}
