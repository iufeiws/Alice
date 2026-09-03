import type { LLMApiPreset } from "../../src/contexts/llm-gateway/src/llm-api-preset.js";

export function testLLMApiPreset(overrides: Partial<LLMApiPreset> = {}): LLMApiPreset {
  return {
    name: "test",
    protocol: "openai-chat-completions",
    credentialId: "test-credential",
    baseURL: "https://example.invalid/v1",
    model: "flash",
    temperature: 0.2,
    timeoutMs: 60_000,
    stream: false,
    supportsImage: false,
    supportsAudio: false,
    extraParams: {},
    followupExtraParams: {},
    ...overrides
  };
}
