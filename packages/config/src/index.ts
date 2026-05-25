export type LLMConfig = {
  provider: "openai-compatible" | "stub";
  baseURL?: string;
  apiKey?: string;
  model: string;
  temperature: number;
  timeoutMs: number;
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

export type AppConfig = {
  core: {
    timezone: string;
    defaultAgentProfile: string;
    inboundDebounceMs: number;
  };
  api: {
    host: string;
    port: number;
  };
  llm: LLMConfig;
  plugins: {
    feishu: FeishuConfig;
  };
  memoryFiles: {
    root: string;
  };
  skills: {
    root: string;
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

export function loadConfig(env: Env = process.env): AppConfig {
  const llmBaseURL = env.LLM_BASE_URL?.replace(/\/+$/, "");
  const llmApiKey = env.LLM_API_KEY;
  const feishuAppId = env.FEISHU_APP_ID;
  const feishuAppSecret = env.FEISHU_APP_SECRET;

  return {
    core: {
      timezone: env.AGENT_TIMEZONE ?? "Asia/Singapore",
      defaultAgentProfile: "main",
      inboundDebounceMs: numberValue(env.AGENT_INBOUND_DEBOUNCE_MS, 1000)
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
      timeoutMs: numberValue(env.LLM_TIMEOUT_MS, 60_000)
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
      }
    },
    memoryFiles: {
      root: "memory-files"
    },
    skills: {
      root: "skills"
    }
  };
}
