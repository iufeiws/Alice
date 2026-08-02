import { createStubLLMClient } from "./index.js";
import type { createMutableLLMClient } from "./index.js";
import { createLLMClientFromPreset, type LLMApiPreset } from "./llm-api-profile.js";

type MutableLLMClient = ReturnType<typeof createMutableLLMClient>;

export function createLLMConfigRuntime(input: {
  fallbackClient: MutableLLMClient;
  resolvePreset(kind: "chat" | "talk"): LLMApiPreset | undefined;
}) {
  return {
    currentChatLLMConfig: () => currentLLMConfig("chat"),
    currentTalkLLMConfig: () => currentLLMConfig("talk")
  };

  function currentLLMConfig(kind: "chat" | "talk") {
    const preset = input.resolvePreset(kind);
    if (!preset) {
      return {
        client: input.fallbackClient,
        model: undefined,
        temperature: undefined,
        maxTokens: undefined,
        extraParams: {},
        followupExtraParams: {},
        presetName: undefined,
        stream: false,
        supportsImage: false,
        supportsAudio: false
      };
    }
    return {
      client: createLLMClientFromPreset(preset) ?? createStubLLMClient(),
      model: preset.model,
      temperature: preset.temperature,
      maxTokens: preset.maxTokens,
      extraParams: preset.extraParams,
      followupExtraParams: preset.followupExtraParams,
      presetName: preset.name,
      stream: preset.stream,
      supportsImage: preset.supportsImage,
      supportsAudio: preset.supportsAudio
    };
  }
}
