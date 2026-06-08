import type { AppConfig } from "../../../packages/config/src/index.js";
import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import { buildLLMTextVariables } from "../../../core/text-renderer/src/index.js";
import { createTtsPlugin, createTtsRemoteAwareVoiceSynthesizer } from "./index.js";
import { createAsrPlugin } from "../../asr/src/index.js";
import type { LLMApiPreset } from "../../../core/llm/src/llm-api-profile.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createVoicePluginRuntime(input: {
  config: AppConfig;
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
