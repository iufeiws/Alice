import type {
  InboundAudioStreamFrame,
  InboundAudioStreamStartFrame
} from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { LLMClient } from "../../../contexts/llm-gateway/src/index.js";
import type { LLMRequestSender } from "../../../contexts/llm-gateway/src/llm-tool-loop.js";
import type { PromptContextRuntime } from "../../../contexts/prompt-context/src/index.js";

export type AsrProvider = "tencent" | "openai_compatible" | "multimodal_llm";
export type AsrResponseFormat = "json" | "text" | "verbose_json";

export type AsrApiPreset = {
  name?: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  useProxy?: boolean;
  stream?: boolean;
  extraParams?: Record<string, unknown>;
  followupExtraParams?: Record<string, unknown>;
};

export type AsrPluginConfig = {
  enabled: boolean;
  defaultProvider: AsrProvider;
  directAudioInputEnabled?: boolean;
  testAudioPath?: string;
  pseudoStreamMinPauseMs?: number;
  providers: {
    openaiCompatible?: {
      apiPresetName?: string;
      responseFormat?: AsrResponseFormat;
      retryCount?: number;
      retryBackoffMs?: number;
    };
    multimodalLlm?: {
      apiPresetName?: string;
      prompt?: string;
      extraParams?: Record<string, unknown>;
    };
    tencent?: {
      appId?: string;
      secretId?: string;
      secretKey?: string;
      endpoint?: string;
      region?: string;
      engineModelType?: string;
      realtimeVoiceFormat?: number;
      realtimeNeedVad?: number;
      pollIntervalMs?: number;
      timeoutMs?: number;
      retryCount?: number;
      retryBackoffMs?: number;
      maxChunkBytes?: number;
      splitSilenceThresholdDb?: number;
      splitMinSilenceMs?: number;
    };
  };
};

export type AsrTranscribeInput = {
  audioFile: File | Blob | Uint8Array | string;
  filename?: string;
  mimeType?: string;
  language?: string;
  provider?: AsrProvider;
  prompt?: string;
  metadata?: Record<string, unknown>;
};

export type AsrTranscribeResult = {
  text: string;
  provider: AsrProvider;
  model?: string;
  language?: string;
  durationMs?: number;
  requestId?: string;
  raw?: unknown;
  rawStream?: {
    streamId: string;
    chunks: number;
    bytes: number;
    metadata?: Record<string, unknown>;
  };
};

export type AsrTranscribeError = {
  ok: false;
  error:
    | "asr_disabled"
    | "missing_audio_file"
    | "unsupported_audio_format"
    | "missing_provider_config"
    | "provider_request_failed"
    | "empty_transcription"
    | "timeout";
  message?: string;
  provider?: AsrProvider;
  requestId?: string;
};

export type AsrPluginDeps = {
  configPath?: string;
  fetch?: typeof fetch;
  createWebSocket?(url: string): AsrWebSocketLike | Promise<AsrWebSocketLike>;
  env?: Record<string, string | undefined>;
  resolveApiPreset?(name: string): AsrApiPreset | undefined;
  sleep?(ms: number): Promise<void>;
  splitAudio?(input: AsrSplitAudioInput): Promise<AsrAudioChunk[]>;
  llmRequestSender?: LLMRequestSender;
  promptRenderer?: PromptContextRuntime | (() => PromptContextRuntime);
  createLlmClientFromPreset?(preset: AsrApiPreset, env: Record<string, string | undefined>): LLMClient | undefined;
  now?(): Date;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export type AsrWebSocketLike = {
  readyState?: number;
  send(data: string | Uint8Array): void | Promise<void>;
  close?(): void;
  addEventListener?(type: "message" | "error" | "close" | "open", listener: (event: { data?: unknown; error?: unknown }) => void): void;
  on?(type: "message" | "error" | "close" | "open", listener: (data: unknown) => void): void;
};

export type AsrAudioChunk = {
  bytes: Uint8Array;
  filename: string;
};

export type AsrSplitAudioInput = {
  filePath: string;
  maxChunkBytes: number;
  silenceThresholdDb: number;
  minSilenceMs: number;
};

export type AsrPlugin = {
  id: "asr";
  config: AsrPluginConfig;
  transcribe(input: AsrTranscribeInput): Promise<AsrTranscribeResult | AsrTranscribeError>;
  createInboundStreamSession(start: InboundAudioStreamStartFrame): AsrInboundStreamSession;
};

export type AsrInboundStreamAccepted = {
  ok: true;
  type: "ack";
  streamId: string;
  sequence: number;
};

export type AsrInboundStreamFinal = {
  ok: true;
  type: "final";
  streamId: string;
  result: AsrTranscribeResult;
};

export type AsrInboundStreamAborted = {
  ok: true;
  type: "aborted";
  streamId: string;
  reason?: string;
};

export type AsrInboundStreamPartial = {
  ok: true;
  type: "partial";
  streamId: string;
  text: string;
  stable: boolean;
  raw?: unknown;
};

export type AsrInboundStreamError = {
  ok: false;
  type: "error";
  streamId: string;
  error: "stream_id_mismatch" | "out_of_order_chunk" | "stream_closed" | "empty_stream" | AsrTranscribeError["error"];
  message?: string;
};

export type AsrInboundStreamAcceptResult =
  | AsrInboundStreamAccepted
  | AsrInboundStreamPartial
  | AsrInboundStreamFinal
  | AsrInboundStreamAborted
  | AsrInboundStreamError;

export type AsrInboundStreamSession = {
  streamId: string;
  accept(frame: Exclude<InboundAudioStreamFrame, InboundAudioStreamStartFrame>): Promise<AsrInboundStreamAcceptResult>;
};
