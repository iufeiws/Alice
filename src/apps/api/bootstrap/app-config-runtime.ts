import { envBool, envJsonObject, envNumber, trimTrailingSlashes, type Env } from "../../../platform/config/src/index.js";
import type { MemorySummaryConfig } from "../../../contexts/memory/src/contracts/memory-config.js";
import type { FeishuConfig } from "../../../channels/feishu/src/types.js";
import type { WeChatConfig } from "../../../channels/wechat/src/types.js";
import { parseBashSandboxMounts, validateBashSandboxConfig, type BashSandboxConfig, type BashSandboxMountConfig } from "../../../contexts/bash-sandbox/src/index.js";
import { readPiWorkerConfig, type PiWorkerConfig } from "../../../contexts/pi-worker/src/index.js";

const path = await import("node:path");

export type LLMConfig = {
  provider: "openai-compatible" | "stub";
  baseURL?: string;
  apiKey?: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  stream: boolean;
  tokenPressureSessionResetEnabled: boolean;
  tokenPressureContextImportance: number;
  extraParams: Record<string, unknown>;
  followupExtraParams: Record<string, unknown>;
};

export type AppConfig = {
  project: {
    username: string;
  };
  core: {
    timezone: string;
    defaultAgentProfile: string;
    inboundDebounceMs: number;
    defaultTargetPlugin: "auto" | "wechat" | "feishu";
    heartbeatPaused: boolean;
  };
  api: {
    host: string;
    port: number;
    httpsEnabled: boolean;
    httpsHost: string;
    httpsPort: number;
  };
  llm: LLMConfig;
  memorySummary: MemorySummaryConfig;
  plugins: {
    feishu: FeishuConfig;
    wechat: WeChatConfig;
  };
  memoryFiles: {
    root: string;
  };
  skills: {
    root: string;
    installedRoot: string;
  };
  bashSandbox: BashSandboxConfig;
  piWorkerConfig: PiWorkerConfig;
  photo: {
    selfieReferenceDir: string;
    selfieOutputDir: string;
    selfieCodexCommand: string;
    selfieCodexExtraPrompt: string;
    selfieCodexTimeoutMs: number;
    selfieImageApiKey?: string;
    selfieImageApiBaseURL: string;
    selfieImageApiRelayKey?: string;
    selfieImageApiRelayBaseURL: string;
    selfieImageApiModel: string;
    selfieImageApiSize: string;
    selfieImageApiQuality: string;
    selfieImageApiModeration: string;
    selfieImageApiOutputFormat: string;
    selfieImageApiOutputCompression: number;
    selfieImageApiTimeoutMs: number;
    selfieImageApiRelayModel: string;
    selfieImageApiRelaySize: string;
    selfieImageApiRelayQuality: string;
    selfieImageApiRelayModeration: string;
    selfieImageApiRelayOutputFormat: string;
    selfieImageApiRelayOutputCompression: number;
    selfieImageApiRelayTimeoutMs: number;
    selfieMaxBytes: number;
    autoGenerateOutfitOnBody: boolean;
    selfie2DinRealEnabled: boolean;
    selfie2DinRealReferenceImage: string;
    selfie2DinRealPrompt: string;
  };
  tts: {
    backend: "genie-tts" | "moss-onnx";
    genieBaseURL: string;
    genieBaseURLExplicit: boolean;
    genieHost: string;
    geniePort: number;
    geniePythonCommand: string;
    genieServiceScript: string;
    genieDataDir: string;
    genieModelDir: string;
    genieCharacterName: string;
    genieLanguage: string;
    genieReferenceAudio: string;
    genieReferenceText: string;
    genieOutputDir: string;
    genieTimeoutMs: number;
    genieIdleShutdownMs: number;
    genieFfmpegCommand: string;
    mossBaseURL: string;
    mossBaseURLExplicit: boolean;
    mossHost: string;
    mossPort: number;
    mossPythonCommand: string;
    mossServiceScript: string;
    mossModelDir: string;
    mossReferenceAudio: string;
    mossOutputDir: string;
    mossTimeoutMs: number;
    mossIdleShutdownMs: number;
    mossFfmpegCommand: string;
    mossVoiceCloneMaxTextTokens: number;
    voiceCallTrainingOutputDir: string;
    voiceMessageTrainingOutputDir: string;
    wechatVoiceFallbackToText: boolean;
    generatedCleanupEnabled: boolean;
  };
};


function normalizeDefaultTargetPlugin(value: string | undefined): "auto" | "wechat" | "feishu" {
  return value === "wechat" || value === "feishu" ? value : "auto";
}

function normalizeTTSBackend(value: string | undefined): "genie-tts" | "moss-onnx" {
  return value === "moss-onnx" ? "moss-onnx" : "genie-tts";
}

function referenceTextPath(referenceAudio: string): string {
  return referenceAudio.replace(/\.[^./\\]+$/, "") + ".txt";
}

export function loadConfig(env: Env = process.env): AppConfig {
  const llmBaseURL = trimTrailingSlashes(env.LLM_BASE_URL);
  const llmApiKey = env.LLM_API_KEY;
  const feishuAppId = env.FEISHU_APP_ID;
  const feishuAppSecret = env.FEISHU_APP_SECRET;
  const wechatBaseURL = (env.WECHAT_ILINK_BASE_URL ?? "https://ilinkai.weixin.qq.com").replace(/\/+$/, "");
  const skillsRoot = env.SKILLS_ROOT ?? "src/capabilities/skills";
  const installedSkillsRoot = env.INSTALLED_SKILLS_ROOT ?? ".agents/skills";
  const sandboxWorkspaceDir = env.BASH_SANDBOX_WORKSPACE_DIR ?? "/home/alice";

  return {
    project: {
      username: env.PROJECT_USERNAME ?? "user"
    },
    core: {
      timezone: env.AGENT_TIMEZONE ?? "Asia/Singapore",
      defaultAgentProfile: "main",
      inboundDebounceMs: envNumber(env.AGENT_INBOUND_DEBOUNCE_MS, 1000),
      defaultTargetPlugin: normalizeDefaultTargetPlugin(env.AGENT_DEFAULT_TARGET_PLUGIN),
      heartbeatPaused: envBool(env.AGENT_HEARTBEAT_PAUSED, true)
    },
    api: {
      host: env.API_HOST ?? "127.0.0.1",
      port: envNumber(env.API_PORT, 3030),
      httpsEnabled: envBool(env.API_HTTPS_ENABLED, true),
      httpsHost: env.API_HTTPS_HOST ?? env.API_HOST ?? "0.0.0.0",
      httpsPort: envNumber(env.API_HTTPS_PORT, 3443)
    },
    llm: {
      provider: llmBaseURL && llmApiKey ? "openai-compatible" : "stub",
      baseURL: llmBaseURL,
      apiKey: llmApiKey,
      model: env.LLM_MODEL ?? "gpt-4.1-mini",
      temperature: envNumber(env.LLM_TEMPERATURE, 0.2),
      timeoutMs: envNumber(env.LLM_TIMEOUT_MS, 60_000),
      stream: envBool(env.LLM_STREAM_ENABLED, true),
      tokenPressureSessionResetEnabled: envBool(env.LLM_TOKEN_PRESSURE_SESSION_RESET_ENABLED, false),
      tokenPressureContextImportance: envNumber(env.LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE, 1),
      extraParams: envJsonObject(env.LLM_EXTRA_PARAMS),
      followupExtraParams: env.LLM_FOLLOWUP_EXTRA_PARAMS === undefined
        ? envJsonObject(env.LLM_EXTRA_PARAMS)
        : envJsonObject(env.LLM_FOLLOWUP_EXTRA_PARAMS)
    },
    memorySummary: {
      enabled: envBool(env.MEMORY_SUMMARY_ENABLED, true),
      manualRunRequiresSleeping: envBool(env.MEMORY_MANUAL_RUN_REQUIRES_SLEEPING, true),
      baseURL: (env.MEMORY_SUMMARY_BASE_URL ?? llmBaseURL ?? "https://api.deepseek.com").replace(/\/+$/, ""),
      apiKey: env.MEMORY_SUMMARY_API_KEY ?? env.DEEPSEEK_API_KEY ?? llmApiKey,
      model: env.MEMORY_SUMMARY_MODEL ?? "deepseek-v4-pro",
      temperature: envNumber(env.MEMORY_SUMMARY_TEMPERATURE, 0.8),
      timeoutMs: envNumber(env.MEMORY_SUMMARY_TIMEOUT_MS, 120_000),
      stream: envBool(env.MEMORY_SUMMARY_STREAM_ENABLED, false),
      extraParams: env.MEMORY_SUMMARY_EXTRA_PARAMS === undefined
        ? { thinking: { type: "enabled" }, reasoning_effort: "high" }
        : envJsonObject(env.MEMORY_SUMMARY_EXTRA_PARAMS),
      followupExtraParams: env.MEMORY_SUMMARY_FOLLOWUP_EXTRA_PARAMS === undefined
        ? env.MEMORY_SUMMARY_EXTRA_PARAMS === undefined
          ? { thinking: { type: "enabled" }, reasoning_effort: "high" }
          : envJsonObject(env.MEMORY_SUMMARY_EXTRA_PARAMS)
        : envJsonObject(env.MEMORY_SUMMARY_FOLLOWUP_EXTRA_PARAMS)
    },
    plugins: {
      feishu: {
        enabled: envBool(env.FEISHU_ENABLED, false),
        connectionMode: env.FEISHU_CONNECTION_MODE === "webhook" ? "webhook" : "websocket",
        accounts:
          feishuAppId && feishuAppSecret
            ? { main: { appId: feishuAppId, appSecret: feishuAppSecret, name: "Agent" } }
            : {},
        dmPolicy: "pairing",
        dmAllowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        requireMention: envBool(env.FEISHU_REQUIRE_MENTION, true),
        codexPolicy: {
          enabled: true,
          requireAllowlist: true,
          allowedUsers: [],
          allowedChats: [],
          requireExplicitCommand: true
        }
      },
      wechat: {
        enabled: envBool(env.WECHAT_ENABLED, false),
        botToken: env.WECHAT_ILINK_BOT_TOKEN,
        baseURL: wechatBaseURL,
        pollTimeoutMs: envNumber(env.WECHAT_ILINK_POLL_TIMEOUT_MS, 35_000)
      }
    },
    memoryFiles: {
      root: "memory-files"
    },
    skills: {
      root: skillsRoot,
      installedRoot: installedSkillsRoot
    },
    bashSandbox: validateBashSandboxConfig({
      containerName: env.BASH_SANDBOX_CONTAINER_NAME ?? "alice-bash-sandbox",
      image: env.BASH_SANDBOX_IMAGE ?? "cimg/python:3.13-browsers",
      defaultCwd: env.BASH_SANDBOX_DEFAULT_CWD ?? "/home/alice",
      hostWorkspaceDir: env.BASH_SANDBOX_HOST_WORKSPACE_DIR ?? ".sandbox/bash/alice",
      workspaceDir: sandboxWorkspaceDir,
      hostCacheDir: env.BASH_SANDBOX_HOST_CACHE_DIR ?? ".sandbox/bash/cache",
      cacheDir: env.BASH_SANDBOX_CACHE_DIR ?? "/cache",
      tmpDir: env.BASH_SANDBOX_TMP_DIR ?? "/tmp",
      skillsDir: env.BASH_SANDBOX_SKILLS_DIR ?? path.posix.join(sandboxWorkspaceDir, ".agent", "skills"),
      skillMounts: [],
      mounts: withDefaultMounts(
        parseBashSandboxMounts(env.BASH_SANDBOX_MOUNTS ? JSON.parse(env.BASH_SANDBOX_MOUNTS) : []),
        installedSkillsRoot,
        sandboxWorkspaceDir,
        env.BASH_SANDBOX_SKILLS_DIR ?? path.posix.join(sandboxWorkspaceDir, ".agent", "skills")
      ),
      network: env.BASH_SANDBOX_NETWORK === "none" ? "none" : "configured",
      timeoutMs: envNumber(env.BASH_SANDBOX_TIMEOUT_MS, 60_000),
      outputLimitBytes: envNumber(env.BASH_SANDBOX_OUTPUT_LIMIT_BYTES, 30_000),
      cpuLimit: env.BASH_SANDBOX_CPU_LIMIT,
      memoryLimit: env.BASH_SANDBOX_MEMORY_LIMIT,
      pidsLimit: env.BASH_SANDBOX_PIDS_LIMIT === undefined ? undefined : envNumber(env.BASH_SANDBOX_PIDS_LIMIT, 256),
      piWorker: {
        enabled: true,
        hostDir: path.resolve("memory-files/pi-sessions"),
        containerDir: path.posix.join(sandboxWorkspaceDir, ".pi-sessions"),
        port: envNumber(env.PI_WORKER_CONTAINER_PORT, 8790)
      }
    }),
    piWorkerConfig: readPiWorkerConfig(),
    photo: {
      selfieReferenceDir: env.SELFIE_REFERENCE_DIR ?? "assets/selfie/references",
      selfieOutputDir: env.SELFIE_OUTPUT_DIR ?? "assets/generated/selfies",
      selfieCodexCommand: env.SELFIE_CODEX_COMMAND ?? "codex",
      selfieCodexExtraPrompt: env.SELFIE_CODEX_EXTRA_PROMPT ?? "",
      selfieCodexTimeoutMs: envNumber(env.SELFIE_CODEX_TIMEOUT_MS, 300_000),
      selfieImageApiKey: env.SELFIE_IMAGE_API_KEY ?? env.OPENAI_API_KEY,
      selfieImageApiBaseURL: (env.SELFIE_IMAGE_API_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      selfieImageApiRelayKey: env.SELFIE_IMAGE_API_RELAY_KEY,
      selfieImageApiRelayBaseURL: (env.SELFIE_IMAGE_API_RELAY_BASE_URL ?? env.SELFIE_IMAGE_API_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      selfieImageApiModel: env.SELFIE_IMAGE_API_MODEL ?? "gpt-image-2",
      selfieImageApiSize: env.SELFIE_IMAGE_API_SIZE ?? "768x1024",
      selfieImageApiQuality: env.SELFIE_IMAGE_API_QUALITY ?? "low",
      selfieImageApiModeration: env.SELFIE_IMAGE_API_MODERATION ?? "low",
      selfieImageApiOutputFormat: env.SELFIE_IMAGE_API_OUTPUT_FORMAT ?? "jpeg",
      selfieImageApiOutputCompression: envNumber(env.SELFIE_IMAGE_API_OUTPUT_COMPRESSION, 45),
      selfieImageApiTimeoutMs: envNumber(env.SELFIE_IMAGE_API_TIMEOUT_MS, 120_000),
      selfieImageApiRelayModel: env.SELFIE_IMAGE_API_RELAY_MODEL ?? env.SELFIE_IMAGE_API_MODEL ?? "gpt-image-2",
      selfieImageApiRelaySize: env.SELFIE_IMAGE_API_RELAY_SIZE ?? env.SELFIE_IMAGE_API_SIZE ?? "768x1024",
      selfieImageApiRelayQuality: env.SELFIE_IMAGE_API_RELAY_QUALITY ?? env.SELFIE_IMAGE_API_QUALITY ?? "low",
      selfieImageApiRelayModeration: env.SELFIE_IMAGE_API_RELAY_MODERATION ?? env.SELFIE_IMAGE_API_MODERATION ?? "low",
      selfieImageApiRelayOutputFormat: env.SELFIE_IMAGE_API_RELAY_OUTPUT_FORMAT ?? env.SELFIE_IMAGE_API_OUTPUT_FORMAT ?? "jpeg",
      selfieImageApiRelayOutputCompression: envNumber(env.SELFIE_IMAGE_API_RELAY_OUTPUT_COMPRESSION, envNumber(env.SELFIE_IMAGE_API_OUTPUT_COMPRESSION, 45)),
      selfieImageApiRelayTimeoutMs: envNumber(env.SELFIE_IMAGE_API_RELAY_TIMEOUT_MS, envNumber(env.SELFIE_IMAGE_API_TIMEOUT_MS, 120_000)),
      selfieMaxBytes: envNumber(env.SELFIE_MAX_BYTES, 10 * 1024 * 1024),
      autoGenerateOutfitOnBody: envBool(env.PHOTO_AUTO_GENERATE_OUTFIT_ON_BODY, false),
      selfie2DinRealEnabled: envBool(env.SELFIE_2DINREAL_ENABLED, false),
      selfie2DinRealReferenceImage: env.SELFIE_2DINREAL_REFERENCE_IMAGE ?? "assets/selfie/references/2dinreal-reference.jpg",
      selfie2DinRealPrompt: env.SELFIE_2DINREAL_PROMPT ?? ""
    },
    tts: {
      backend: normalizeTTSBackend(env.TTS_BACKEND),
      genieBaseURL: (env.GENIE_TTS_BASE_URL ?? `http://${env.GENIE_TTS_HOST ?? "127.0.0.1"}:${envNumber(env.GENIE_TTS_PORT, 8767)}`).replace(/\/+$/, ""),
      genieBaseURLExplicit: Boolean(env.GENIE_TTS_BASE_URL),
      genieHost: env.GENIE_TTS_HOST ?? "127.0.0.1",
      geniePort: envNumber(env.GENIE_TTS_PORT, 8767),
      geniePythonCommand: env.GENIE_TTS_PYTHON_COMMAND ?? ".conda-moss/bin/python",
      genieServiceScript: env.GENIE_TTS_SERVICE_SCRIPT ?? "scripts/genie_tts/service.py",
      genieDataDir: env.GENIE_TTS_DATA_DIR ?? "assets/tts/genie/GenieData",
      genieModelDir: env.GENIE_TTS_MODEL_DIR ?? "assets/tts/genie/models/alice",
      genieCharacterName: env.GENIE_TTS_CHARACTER_NAME ?? "alice",
      genieLanguage: env.GENIE_TTS_LANGUAGE ?? "zh",
      genieReferenceAudio: env.GENIE_TTS_REFERENCE_AUDIO ?? env.MOSS_TTS_REFERENCE_AUDIO ?? "assets/tts/references/alice/reference.wav",
      genieReferenceText: env.GENIE_TTS_REFERENCE_TEXT ?? referenceTextPath(env.GENIE_TTS_REFERENCE_AUDIO ?? env.MOSS_TTS_REFERENCE_AUDIO ?? "assets/tts/references/alice/reference.wav"),
      genieOutputDir: env.GENIE_TTS_OUTPUT_DIR ?? env.MOSS_TTS_OUTPUT_DIR ?? "assets/generated/tts",
      genieTimeoutMs: envNumber(env.GENIE_TTS_TIMEOUT_MS ?? env.MOSS_TTS_TIMEOUT_MS, 120_000),
      genieIdleShutdownMs: envNumber(env.GENIE_TTS_IDLE_SHUTDOWN_MS ?? env.MOSS_TTS_IDLE_SHUTDOWN_MS, 15 * 60 * 1000),
      genieFfmpegCommand: env.GENIE_TTS_FFMPEG_COMMAND ?? env.MOSS_TTS_FFMPEG_COMMAND ?? "ffmpeg-static",
      mossBaseURL: (env.MOSS_TTS_BASE_URL ?? `http://${env.MOSS_TTS_HOST ?? "127.0.0.1"}:${envNumber(env.MOSS_TTS_PORT, 8765)}`).replace(/\/+$/, ""),
      mossBaseURLExplicit: Boolean(env.MOSS_TTS_BASE_URL),
      mossHost: env.MOSS_TTS_HOST ?? "127.0.0.1",
      mossPort: envNumber(env.MOSS_TTS_PORT, 8765),
      mossPythonCommand: env.MOSS_TTS_PYTHON_COMMAND ?? ".conda-moss/bin/python",
      mossServiceScript: env.MOSS_TTS_SERVICE_SCRIPT ?? "scripts/moss_tts_onnx/service.py",
      mossModelDir: env.MOSS_TTS_MODEL_DIR ?? "assets/tts/moss-onnx/models",
      mossReferenceAudio: env.MOSS_TTS_REFERENCE_AUDIO ?? "assets/tts/references/alice/reference.wav",
      mossOutputDir: env.MOSS_TTS_OUTPUT_DIR ?? "assets/generated/tts",
      mossTimeoutMs: envNumber(env.MOSS_TTS_TIMEOUT_MS, 120_000),
      mossIdleShutdownMs: envNumber(env.MOSS_TTS_IDLE_SHUTDOWN_MS, 15 * 60 * 1000),
      mossFfmpegCommand: env.MOSS_TTS_FFMPEG_COMMAND ?? "ffmpeg-static",
      mossVoiceCloneMaxTextTokens: envNumber(env.MOSS_TTS_VOICE_CLONE_MAX_TEXT_TOKENS, 75),
      voiceCallTrainingOutputDir: env.TTS_VOICE_CALL_TRAINING_OUTPUT_DIR ?? "assets/generated/tts-training/voice-call",
      voiceMessageTrainingOutputDir: env.TTS_VOICE_MESSAGE_TRAINING_OUTPUT_DIR ?? "assets/generated/tts-training/voice-massage",
      wechatVoiceFallbackToText: envBool(env.TTS_WECHAT_VOICE_FALLBACK_TO_TEXT, true),
      generatedCleanupEnabled: envBool(env.TTS_GENERATED_CLEANUP_ENABLED, true)
    }
  };
}

function withDefaultMounts(mounts: BashSandboxMountConfig[], installedSkillsRoot: string, workspaceDir: string, skillsDir: string): BashSandboxMountConfig[] {
  const workspaceRoot = workspaceDir.replace(/\/+$/, "");
  const agentMount: BashSandboxMountConfig = {
    id: "agent",
    hostPath: path.dirname(path.resolve(installedSkillsRoot)),
    containerPath: path.posix.dirname(skillsDir),
    readOnly: false
  };
  const codebaseMounts: BashSandboxMountConfig[] = [
    { id: "codebase_src", hostPath: "src", containerPath: `${workspaceRoot}/codebase/src`, readOnly: false },
    { id: "codebase_memory_files", hostPath: "memory-files", containerPath: `${workspaceRoot}/codebase/memory-files`, readOnly: false },
    { id: "codebase_tests", hostPath: "tests", containerPath: `${workspaceRoot}/codebase/tests`, readOnly: false },
    { id: "codebase_scripts", hostPath: "scripts", containerPath: `${workspaceRoot}/codebase/scripts`, readOnly: false },
    { id: "codebase_docs", hostPath: "docs", containerPath: `${workspaceRoot}/codebase/docs`, readOnly: false }
  ];
  const defaultContainerPaths = new Set([agentMount, ...codebaseMounts].map((mount) => mount.containerPath));
  const optional = mounts.filter((mount) => !defaultContainerPaths.has(mount.containerPath));
  if (!mounts.some((mount) => mount.containerPath === "/assets")) {
    optional.unshift({ id: "assets", hostPath: "assets", containerPath: "/assets", readOnly: true });
  }
  return [agentMount, ...codebaseMounts, ...optional];
}
