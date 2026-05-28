export type LLMConfig = {
  provider: "openai-compatible" | "stub";
  baseURL?: string;
  apiKey?: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  stream: boolean;
  extraParams: Record<string, unknown>;
  followupExtraParams: Record<string, unknown>;
};

export type FeishuConfig = {
  enabled: boolean;
  connectionMode: "websocket" | "webhook";
  accounts: Record<string, { appId: string; appSecret: string; name?: string }>;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  dmAllowFrom: string[];
  groupPolicy: "allowlist" | "open" | "disabled";
  groupAllowFrom: string[];
  requireMention: boolean;
  codexPolicy: {
    enabled: boolean;
    requireAllowlist: boolean;
    allowedUsers: string[];
    allowedChats: string[];
    requireExplicitCommand: boolean;
  };
};

export type WeChatConfig = {
  enabled: boolean;
  botToken?: string;
  baseURL: string;
  pollTimeoutMs: number;
};

export type AppConfig = {
  core: {
    timezone: string;
    defaultAgentProfile: string;
    inboundDebounceMs: number;
    defaultTargetPlugin: "auto" | "wechat" | "feishu";
  };
  api: {
    host: string;
    port: number;
  };
  llm: LLMConfig;
  plugins: {
    feishu: FeishuConfig;
    wechat: WeChatConfig;
  };
  memoryFiles: {
    root: string;
  };
  skills: {
    root: string;
  };
  media: {
    selfieReferenceDir: string;
    selfieOutputDir: string;
    selfieCodexCommand: string;
    selfieCodexTimeoutMs: number;
    selfieImageApiKey?: string;
    selfieImageApiBaseURL: string;
    selfieImageApiModel: string;
    selfieImageApiSize: string;
    selfieImageApiQuality: string;
    selfieImageApiOutputFormat: string;
    selfieImageApiOutputCompression: number;
    selfieImageApiTimeoutMs: number;
    selfieMaxBytes: number;
  };
  tts: {
    genieBaseURL: string;
    genieCharacterName: string;
    genieModelDir: string;
    genieLanguage: string;
    genieReferenceAudio: string;
    genieReferenceText: string;
    genieOutputDir: string;
    genieTimeoutMs: number;
  };
};

type Env = Record<string, string | undefined>;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberValue(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function jsonObjectValue(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeDefaultTargetPlugin(value: string | undefined): "auto" | "wechat" | "feishu" {
  return value === "wechat" || value === "feishu" ? value : "auto";
}

export function loadConfig(env: Env = process.env): AppConfig {
  const llmBaseURL = env.LLM_BASE_URL?.replace(/\/+$/, "");
  const llmApiKey = env.LLM_API_KEY;
  const feishuAppId = env.FEISHU_APP_ID;
  const feishuAppSecret = env.FEISHU_APP_SECRET;
  const wechatBaseURL = (env.WECHAT_ILINK_BASE_URL ?? "https://ilinkai.weixin.qq.com").replace(/\/+$/, "");

  return {
    core: {
      timezone: env.AGENT_TIMEZONE ?? "Asia/Singapore",
      defaultAgentProfile: "main",
      inboundDebounceMs: numberValue(env.AGENT_INBOUND_DEBOUNCE_MS, 1000),
      defaultTargetPlugin: normalizeDefaultTargetPlugin(env.AGENT_DEFAULT_TARGET_PLUGIN)
    },
    api: {
      host: env.API_HOST ?? "127.0.0.1",
      port: numberValue(env.API_PORT, 3030)
    },
    llm: {
      provider: llmBaseURL && llmApiKey ? "openai-compatible" : "stub",
      baseURL: llmBaseURL,
      apiKey: llmApiKey,
      model: env.LLM_MODEL ?? "gpt-4.1-mini",
      temperature: numberValue(env.LLM_TEMPERATURE, 0.2),
      timeoutMs: numberValue(env.LLM_TIMEOUT_MS, 60_000),
      stream: bool(env.LLM_STREAM_ENABLED, true),
      extraParams: jsonObjectValue(env.LLM_EXTRA_PARAMS),
      followupExtraParams: env.LLM_FOLLOWUP_EXTRA_PARAMS === undefined
        ? jsonObjectValue(env.LLM_EXTRA_PARAMS)
        : jsonObjectValue(env.LLM_FOLLOWUP_EXTRA_PARAMS)
    },
    plugins: {
      feishu: {
        enabled: bool(env.FEISHU_ENABLED, false),
        connectionMode: env.FEISHU_CONNECTION_MODE === "webhook" ? "webhook" : "websocket",
        accounts:
          feishuAppId && feishuAppSecret
            ? { main: { appId: feishuAppId, appSecret: feishuAppSecret, name: "Agent" } }
            : {},
        dmPolicy: "pairing",
        dmAllowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        requireMention: bool(env.FEISHU_REQUIRE_MENTION, true),
        codexPolicy: {
          enabled: true,
          requireAllowlist: true,
          allowedUsers: [],
          allowedChats: [],
          requireExplicitCommand: true
        }
      },
      wechat: {
        enabled: bool(env.WECHAT_ENABLED, false),
        botToken: env.WECHAT_ILINK_BOT_TOKEN,
        baseURL: wechatBaseURL,
        pollTimeoutMs: numberValue(env.WECHAT_ILINK_POLL_TIMEOUT_MS, 35_000)
      }
    },
    memoryFiles: {
      root: "memory-files"
    },
    skills: {
      root: "skills"
    },
    media: {
      selfieReferenceDir: env.SELFIE_REFERENCE_DIR ?? "assets/selfie/references",
      selfieOutputDir: env.SELFIE_OUTPUT_DIR ?? "assets/generated/selfies",
      selfieCodexCommand: env.SELFIE_CODEX_COMMAND ?? "codex",
      selfieCodexTimeoutMs: numberValue(env.SELFIE_CODEX_TIMEOUT_MS, 180_000),
      selfieImageApiKey: env.SELFIE_IMAGE_API_KEY ?? env.OPENAI_API_KEY,
      selfieImageApiBaseURL: (env.SELFIE_IMAGE_API_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      selfieImageApiModel: env.SELFIE_IMAGE_API_MODEL ?? "gpt-image-2",
      selfieImageApiSize: env.SELFIE_IMAGE_API_SIZE ?? "768x1024",
      selfieImageApiQuality: env.SELFIE_IMAGE_API_QUALITY ?? "low",
      selfieImageApiOutputFormat: env.SELFIE_IMAGE_API_OUTPUT_FORMAT ?? "jpeg",
      selfieImageApiOutputCompression: numberValue(env.SELFIE_IMAGE_API_OUTPUT_COMPRESSION, 45),
      selfieImageApiTimeoutMs: numberValue(env.SELFIE_IMAGE_API_TIMEOUT_MS, 120_000),
      selfieMaxBytes: numberValue(env.SELFIE_MAX_BYTES, 10 * 1024 * 1024)
    },
    tts: {
      genieBaseURL: (env.GENIE_TTS_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, ""),
      genieCharacterName: env.GENIE_TTS_CHARACTER_NAME ?? "alice",
      genieModelDir: env.GENIE_TTS_MODEL_DIR ?? "assets/tts/models/alice",
      genieLanguage: env.GENIE_TTS_LANGUAGE ?? "zh",
      genieReferenceAudio: env.GENIE_TTS_REFERENCE_AUDIO ?? "assets/tts/reference/reference.wav",
      genieReferenceText: env.GENIE_TTS_REFERENCE_TEXT ?? "assets/tts/reference/reference.txt",
      genieOutputDir: env.GENIE_TTS_OUTPUT_DIR ?? "assets/generated/tts",
      genieTimeoutMs: numberValue(env.GENIE_TTS_TIMEOUT_MS, 120_000)
    }
  };
}
