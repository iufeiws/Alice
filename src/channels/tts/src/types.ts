import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { LLMTextVariables } from "../../../contexts/agent-profile/src/application/llm-text-renderer.js";

export type TTSConfig = {
  backend?: "genie-tts" | "moss-onnx";
  genieBaseURL?: string;
  genieBaseURLExplicit?: boolean;
  genieHost?: string;
  geniePort?: number;
  geniePythonCommand?: string;
  genieServiceScript?: string;
  genieDataDir?: string;
  genieModelDir?: string;
  genieCharacterName?: string;
  genieLanguage?: string;
  genieReferenceAudio?: string;
  genieReferenceText?: string;
  genieOutputDir?: string;
  genieTimeoutMs?: number;
  genieIdleShutdownMs?: number;
  genieFfmpegCommand?: string;
  genieUseStreamForSynthesis?: boolean;
  mossBaseURL?: string;
  mossBaseURLExplicit?: boolean;
  mossHost?: string;
  mossPort?: number;
  mossPythonCommand?: string;
  mossServiceScript?: string;
  mossModelDir?: string;
  mossReferenceAudio?: string;
  mossOutputDir?: string;
  mossTimeoutMs?: number;
  mossIdleShutdownMs?: number;
  mossFfmpegCommand?: string;
  mossVoiceCloneMaxTextTokens?: number;
  assetRoot?: string;
};

export type VoiceSynthesisInput = {
  text: string;
  time: CurrentTimeProvider;
  genie?: {
    language?: string;
    modelDir?: string;
    referenceAudio?: string;
    referenceText?: string;
    speed?: number;
    partSilenceSeconds?: number;
    splitText?: boolean;
  };
};

export type VoiceSynthesisResult = {
  assetId: string;
  filePath: string;
};

export type VoiceSynthesizer = ((input: VoiceSynthesisInput) => Promise<VoiceSynthesisResult>) & {
  streamAudio?(input: VoiceSynthesisInput): AsyncIterable<Uint8Array>;
  streamAudioWithText?(input: VoiceSynthesisInput): AsyncIterable<TtsAudioTextChunk>;
  noteActivity?(): void;
  prepare?(): Promise<void>;
  shutdown?(): Promise<void>;
};

export type FallbackVoiceSynthesizerDeps = {
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export type TtsApiPreset = {
  name?: string;
  baseURL: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  extraParams?: Record<string, unknown>;
};

export type TtsPluginConfig = {
  enabled: boolean;
  remote?: TtsRemoteConfig;
  conversion?: TtsConversionConfig;
  translationPresetName?: string;
  translationPresets?: Record<string, TtsTranslationPreset>;
  translationEnabled: boolean;
  apiPresetName?: string;
  api_preset?: TtsApiPreset;
  prompt: string;
  voice?: {
    modelConfigName?: string;
    modelConfigs?: Record<string, TtsVoiceModelConfig>;
  };
};

export type TtsRemoteConfig = {
  enabled?: boolean;
  baseURL?: string;
};

export type TtsConversionConfig = {
  provider?: "genie" | "openai-api" | "bailian";
  genie?: TtsRemoteConfig;
  openaiApi?: TtsOpenAiApiConversionConfig;
  bailian?: TtsBailianConversionConfig;
};

export type TtsOpenAiApiConversionConfig = {
  apiPresetName?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  voice?: string;
  timeoutMs?: number;
  sampleRate?: number;
  channels?: number;
  extraParams?: Record<string, unknown>;
};

export type TtsBailianConversionConfig = {
  service?: "qwen" | "cosy";
  endpoint?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  workspaceId?: string;
  userAgent?: string;
  model?: string;
  voice?: string;
  languageType?: string;
  mode?: "server_commit" | "commit";
  responseFormat?: string;
  sampleRate?: number;
  channels?: number;
  timeoutMs?: number;
  extraParams?: Record<string, unknown>;
};

export type TtsTranslationPreset = {
  translationEnabled?: boolean;
  apiPresetName?: string;
  prompt?: string;
};

export type TtsVoiceModelConfig = {
  language?: "jp" | "zh" | "en";
  speed?: number;
  partSilenceSeconds?: number;
  splitText?: boolean;
  modelDir?: string;
  referenceAudio?: string;
  referenceText?: string;
};

export type TtsLlmRequest = {
  agentId: string;
  client?: TtsLlmClient;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  model?: string;
  temperature?: number;
  extraParams?: Record<string, unknown>;
  toolNames?: string[];
  round?: number;
  stream?: boolean;
  metadata?: Record<string, unknown>;
};

export type TtsLlmResult = {
  message: { role?: string; content: string };
};

export type TtsLlmClient = {
  chat(input: {
    messages: TtsLlmRequest["messages"];
    model?: string;
    temperature?: number;
    extraParams?: Record<string, unknown>;
  }): Promise<TtsLlmResult>;
};

export type TtsLlmRequestSender = (request: TtsLlmRequest) => Promise<TtsLlmResult>;

export type TtsTokenUsageRecorder = (event: {
  createdAt: string;
  createdAtUtc?: string;
  agentId: string;
  model?: string;
  result: {
    message: { role?: string; content: string };
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    };
    raw?: unknown;
  };
}) => void;

export type TtsPluginDeps = {
  baseSynthesizer: VoiceSynthesizer;
  configPath?: string;
  llm?: TtsLlmClient;
  llmRequestSender?: TtsLlmRequestSender;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  resolveApiPreset?(name: string): TtsApiPreset | undefined;
  createLlmClientFromPreset?(preset: TtsApiPreset, env: Record<string, string | undefined>): TtsLlmClient | undefined;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  recordTokenUsageEvent?: TtsTokenUsageRecorder;
  promptVariables?: LLMTextVariables | (() => LLMTextVariables);
};

export type TtsPlugin = {
  id: "tts";
  config: TtsPluginConfig;
  voiceSynthesizer: TtsSynthesizer;
};

export type TtsStreamInput = {
  text: AsyncIterable<string> | Iterable<string> | string;
  time: CurrentTimeProvider;
  source: "send_chat.voice";
  streamId?: string;
  onInputBufferIdle?(): void | Promise<void>;
  beforeBackendRequest?(input: { sequence: number; text: string }): void | Promise<void>;
};

export type TtsStreamChunk =
  | { type: "translation_started"; sequence: number; sourceChars: number }
  | { type: "translation_done"; sequence: number; translatedChars: number }
  | { type: "audio_file"; sequence: number; text?: string; textchunk?: string; assetId: string; filePath: string }
  | { type: "audio"; sequence: number; text?: string; textchunk?: string; chunk: Uint8Array; soundchunk?: Uint8Array; contentType: string; sampleRateHz?: number; channels?: number }
  | { type: "part_done"; sequence: number }
  | { type: "done" };

export type TtsAudioTextChunk = {
  text?: string;
  chunk: Uint8Array;
  sampleRateHz?: number;
  channels?: number;
};

export type TtsSynthesizer = VoiceSynthesizer & {
  stream?(input: TtsStreamInput): AsyncIterable<TtsStreamChunk>;
};

export type MossOnnxVoiceSynthesizerDeps = {
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  spawn?: typeof import("node:child_process").spawn;
  fetch?: typeof fetch;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type ConfiguredVoiceSynthesizerDeps = MossOnnxVoiceSynthesizerDeps;
