import { test } from "node:test";
import assert from "node:assert/strict";
import { createStubLLMClient, createMutableLLMClient, createApiKeyAuthorization, setActiveCredentialRuntime } from "../../../src/contexts/llm-gateway/src/index.js";
import { createLLMConfigRuntime } from "../../../src/contexts/llm-gateway/src/llm-config-runtime.js";

test("LLM config runtime forwards optional preset maxTokens", () => {
  setActiveCredentialRuntime({ resolveAuthorization: () => createApiKeyAuthorization("test") } as any);
  const fallback = createMutableLLMClient(createStubLLMClient());
  const runtime = createLLMConfigRuntime({
    fallbackClient: fallback,
    resolvePreset(kind) {
      if (kind !== "chat") return undefined;
      return {
        name: "chat",
        protocol: "openai-chat-completions",
        credentialId: "test",
        baseURL: "https://example.test/v1",
        model: "chat-model",
        temperature: 0.2,
        maxTokens: 4096,
        timeoutMs: 60_000,
        stream: true,
        supportsImage: false,
        supportsAudio: false,
        extraParams: {},
        followupExtraParams: {}
      };
    }
  });

  assert.equal(runtime.currentChatLLMConfig().maxTokens, 4096);
  assert.equal(runtime.currentTalkLLMConfig().maxTokens, undefined);
});
