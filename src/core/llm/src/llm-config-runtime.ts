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
        extraParams: {},
        followupExtraParams: {},
        stream: false
      };
    }
    return {
      client: createLLMClientFromPreset(preset) ?? createStubLLMClient(),
      model: preset.model,
      temperature: preset.temperature,
      extraParams: preset.extraParams,
      followupExtraParams: preset.followupExtraParams,
      stream: preset.stream
    };
  }
}
