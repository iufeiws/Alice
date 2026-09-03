export type LLMProtocol = "openai-chat-completions" | "openai-responses";

export type LLMApiPreset = {
  name: string;
  protocol: LLMProtocol;
  credentialId: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
  stream: boolean;
  useProxy?: boolean;
  supportsImage: boolean;
  supportsAudio: boolean;
  extraParams: Record<string, unknown>;
  followupExtraParams: Record<string, unknown>;
};

export function normalizeLLMApiPreset(value: unknown): LLMApiPreset | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const preset = value as Partial<LLMApiPreset>;
  if (!preset.name || !preset.model || !preset.credentialId) return undefined;
  if (preset.protocol !== "openai-chat-completions" && preset.protocol !== "openai-responses") return undefined;
  return {
    name: String(preset.name),
    protocol: preset.protocol,
    credentialId: String(preset.credentialId),
    baseURL: typeof preset.baseURL === "string" ? preset.baseURL : "",
    model: String(preset.model),
    temperature: Number.isFinite(Number(preset.temperature)) ? Number(preset.temperature) : 0.2,
    maxTokens: Number.isInteger(Number(preset.maxTokens)) && Number(preset.maxTokens) > 0 ? Number(preset.maxTokens) : undefined,
    timeoutMs: Number.isFinite(Number(preset.timeoutMs)) ? Number(preset.timeoutMs) : 60_000,
    stream: preset.stream !== false,
    useProxy: preset.useProxy === true,
    supportsImage: preset.supportsImage === true,
    supportsAudio: preset.supportsAudio === true,
    extraParams: objectValue(preset.extraParams),
    followupExtraParams: objectValue(preset.followupExtraParams)
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
