import { defaultMessagingPluginConfigPath, readMessagingPluginConfig, type MessagingPluginConfig } from "../../../capabilities/tools/messaging/src/index.js";
import { readJsonBody } from "../../../apps/api/middleware/http-utils.js";
import { publicLLMApiPresets, readLLMApiPresets } from "../../llm-gateway/src/admin-presets.js";
import { writeJson } from "../../../apps/api/routes/admin-http.js";
import { updateEnvFile } from "../../../apps/api/server/env-file.js";
import { booleanFromUnknown, numberFromUnknown, optionalString, requiredString } from "../../../shared/admin-input/src/index.js";
import { parseBashSandboxMounts, validateBashSandboxConfig, type BashSandboxConfig, type PiWorkerContainerConfig } from "../../bash-sandbox/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import { asrPluginEntry } from "./admin-plugin-asr-runtime.js";
import { googleStreetViewPluginEntry, worldWandererPluginEntry } from "./admin-plugin-geo-runtime.js";
import { imageRecognitionPluginEntry } from "./admin-plugin-image-recognition-runtime.js";
import { generatePhotoOnBody, photoPluginEntry } from "./admin-plugin-photo-runtime.js";
import { ttsPluginEntry } from "./admin-plugin-tts-runtime.js";
import type { AdminPluginRegistryEntry, AdminPluginSummary, TtsAdminConfig } from "./admin-plugin-types.js";
import { createPiPresetSnapshot } from "../../llm-gateway/src/pi-preset-adapter.js";
import { readPiWorkerConfig, validatePiWorkerConfig, writePiWorkerConfig, type PiWorkerConfig } from "../../pi-worker/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export async function handleAdminPluginApi(context: AdminRoutesContext, request: any, response: any): Promise<boolean> {
  if (!request.url?.startsWith("/admin/api/plugins")) return false;
  const url = new URL(request.url, "http://admin.local");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "admin" || parts[1] !== "api" || parts[2] !== "plugins") return false;

  if (request.method === "GET" && parts.length === 3) {
    writeJson(response, 200, { plugins: listAdminPlugins(context) });
    return true;
  }

  const pluginId = parts[3] ?? "";
  const action = parts[4];
  if (!pluginId || !action) return false;

  if (request.method === "POST" && action === "assets" && parts.length === 6) {
    await uploadAdminPluginAsset(context, request, response, pluginId, parts[5]);
    return true;
  }

  if (parts.length !== 5) return false;

  if (request.method === "POST" && pluginId === "photo" && action === "on-body") {
    await generatePhotoOnBody(context, request, response);
    return true;
  }

  if (request.method === "GET" && action === "config") {
    writeAdminPluginConfig(context, response, pluginId);
    return true;
  }
  if (request.method === "GET" && action === "preview") {
    await previewAdminPlugin(context, response, pluginId);
    return true;
  }
  if (request.method === "PATCH" && action === "config") {
    await patchAdminPluginConfig(context, request, response, pluginId);
    return true;
  }
  if (request.method === "POST" && action === "enable") {
    await setAdminPluginEnabled(context, response, pluginId, true);
    return true;
  }
  if (request.method === "POST" && action === "disable") {
    await setAdminPluginEnabled(context, response, pluginId, false);
    return true;
  }
  if (request.method === "POST" && action === "reload") {
    reloadAdminPlugin(context, response, pluginId);
    return true;
  }
  if (request.method === "POST" && action === "test") {
    await testAdminPlugin(context, request, response, pluginId);
    return true;
  }
  if (request.method === "GET" && action === "events") {
    writeAdminPluginEvents(context, response, pluginId);
    return true;
  }

  return false;
}

function listAdminPlugins(context: AdminRoutesContext): AdminPluginSummary[] {
  return adminPluginRegistry(context).map((entry) => entry.summary(context));
}

function findAdminPluginEntry(context: AdminRoutesContext, pluginId: string): AdminPluginRegistryEntry | undefined {
  return adminPluginRegistry(context).find((entry) => entry.summary(context).id === pluginId);
}

function adminPluginRegistry(_context: AdminRoutesContext): AdminPluginRegistryEntry[] {
  return [
    messagingPluginEntry(),
    bashSandboxPluginEntry(),
    piWorkerPluginEntry(),
    asrPluginEntry(),
    imageRecognitionPluginEntry(),
    ttsPluginEntry(),
    photoPluginEntry(),
    googleStreetViewPluginEntry(),
    worldWandererPluginEntry()
  ];
}

function messagingPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      readMessagingConfigForAdmin(context);
      return {
        id: "messaging",
        name: "Messaging",
        kind: "tool",
        status: "enabled",
        health: "healthy",
        description: "Shared Chat poll/send tool behavior.",
        configurable: true,
        switchable: false,
        configSource: messagingConfigPath(context),
        lastLoadedAt: messagingConfigMtime(context)
      };
    },
    config(context) {
      return readMessagingConfigForAdmin(context);
    },
    patch(context, patch) {
      const config = updateMessagingConfig(context, patch);
      return { config };
    },
    reload(context) {
      return { config: readMessagingConfigForAdmin(context) };
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "feishu", label: "Feishu" }
      ],
      fields: [
        { key: "splitMultilineSendChat", label: "Split Multiline Chat Send", type: "switch", group: "general", description: "Split Chat action=send message content on newlines. Voice, markdown, image, and Feishu core markdown sends are never split." },
        { key: "limitConsecutiveSends", label: "Limit Consecutive Sends", type: "switch", group: "general", description: "Block Chat action=send after 10 recent outbound messages until the user replies." },
        { key: "mapMarkdownLikeToMarkdown", label: "Map Markdown-like Message to Markdown", type: "switch", group: "general", description: "When Chat action=send type is message but the content looks like markdown (headings, lists, bold, code, links...), send it as markdown on Feishu." },
        { key: "feishuTypingEmojiEnabled", label: "Typing Emoji Indicator", type: "switch", group: "feishu", description: "Use the Feishu reaction-based typing indicator while Alice is preparing a reply." }
      ]
    },
    routePreview: [
      "Chat action=send tool call",
      "messaging plugin config",
      "conversation store",
      "channel send"
    ],
    runtimeAccess: [
      "read current messaging conversation",
      "write outbound message records",
      "send text, markdown, image, or voice through the selected channel"
    ]
  };
}

function updateMessagingConfig(context: AdminRoutesContext, patch: Record<string, unknown>): MessagingPluginConfig {
  const current = readMessagingConfigForAdmin(context);
  const next: MessagingPluginConfig = {
    splitMultilineSendChat: patch.splitMultilineSendChat === undefined ? current.splitMultilineSendChat : booleanFromUnknown(patch.splitMultilineSendChat),
    limitConsecutiveSends: patch.limitConsecutiveSends === undefined ? current.limitConsecutiveSends : booleanFromUnknown(patch.limitConsecutiveSends),
    feishuTypingEmojiEnabled: patch.feishuTypingEmojiEnabled === undefined ? current.feishuTypingEmojiEnabled : booleanFromUnknown(patch.feishuTypingEmojiEnabled),
    mapMarkdownLikeToMarkdown: patch.mapMarkdownLikeToMarkdown === undefined ? current.mapMarkdownLikeToMarkdown : booleanFromUnknown(patch.mapMarkdownLikeToMarkdown)
  };
  writeMessagingConfig(context, next);
  return next;
}

function readMessagingConfigForAdmin(context: AdminRoutesContext): MessagingPluginConfig {
  return readMessagingPluginConfig(messagingConfigPath(context));
}

function writeMessagingConfig(context: AdminRoutesContext, config: MessagingPluginConfig): void {
  const filePath = messagingConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function messagingConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.messaging?.configPath ?? defaultMessagingPluginConfigPath;
}

function messagingConfigMtime(context: AdminRoutesContext): string | undefined {
  const filePath = messagingConfigPath(context);
  return fs.existsSync(filePath) ? fs.statSync(filePath).mtime.toISOString() : undefined;
}

function piWorkerPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      const config = readPiWorkerConfigForAdmin(context);
      return {
        id: "pi_worker",
        name: "Pi Worker",
        kind: "tool",
        status: "enabled",
        health: config.llmPresetName ? "healthy" : "degraded",
        description: "Docker-backed Pi Worker and SubAgent runtime.",
        configurable: true,
        switchable: false,
        configSource: piWorkerConfigPath(context)
      };
    },
    config(context) {
      return readPiWorkerConfigForAdmin(context);
    },
    runtimeState(context) {
      return context.piWorker?.runtime ? { health: context.piWorker.runtime.health().catch((error) => ({ ready: false, error: error instanceof Error ? error.message : String(error) })) } : undefined;
    },
    async preview(context) {
      const config = readPiWorkerConfigForAdmin(context);
      if (!config.llmPresetName) return { error: "pi_llm_preset_not_configured" };
      if (!context.piWorker?.runtime) return { error: "pi_worker_unavailable" };
      return await context.piWorker.runtime.previewPrompt({ presetName: config.llmPresetName });
    },
    async patch(context, patch) {
      const current = readPiWorkerConfigForAdmin(context);
      const nextInput: PiWorkerConfig = {
        ...current,
        llmPresetName: piWorkerStringField(patch, "llmPresetName", current.llmPresetName),
        maxConcurrency: piWorkerNumberField(patch, "maxConcurrency", current.maxConcurrency),
        maxQueueSize: piWorkerNumberField(patch, "maxQueueSize", current.maxQueueSize),
        taskTimeoutSeconds: piWorkerNumberField(patch, "taskTimeoutSeconds", current.taskTimeoutSeconds),
        toolTimeoutSeconds: piWorkerNumberField(patch, "toolTimeoutSeconds", current.toolTimeoutSeconds),
        relayHost: piWorkerStringField(patch, "relayHost", current.relayHost),
        relayPort: piWorkerNumberField(patch, "relayPort", current.relayPort),
        workerHost: piWorkerStringField(patch, "workerHost", current.workerHost),
        workerPort: piWorkerNumberField(patch, "workerPort", current.workerPort)
      };
      const preset = readLLMApiPresets(context).find((entry) => entry.name === nextInput.llmPresetName);
      if (!preset) return { error: "pi_llm_preset_not_found" };
      try {
        createPiPresetSnapshot(preset);
        const next = validatePiWorkerConfig(nextInput);
        writePiWorkerConfig(next, piWorkerConfigPath(context));
        context.config.piWorkerConfig = next;
        const runtime = context.piWorker?.runtime;
        if (!runtime) return { config: next, restartRequired: true };
        await runtime.refresh("config");
        return { config: next, restartRequired: false };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "invalid_pi_worker_config" };
      }
    },
    reload(context) {
      const config = readPiWorkerConfigForAdmin(context);
      context.config.piWorkerConfig = config;
      return { config };
    },
    configSchema: {
      groups: [
        { key: "preset", label: "LLM" },
        { key: "worker", label: "Worker" },
        { key: "relay", label: "Relay" }
      ],
      fields: [
        { key: "llmPresetName", label: "Alice LLM Preset", type: "select", group: "preset" },
        { key: "maxConcurrency", label: "Max Concurrency", type: "number", group: "worker", min: 1, max: 64, step: 1 },
        { key: "maxQueueSize", label: "Max Queue Size", type: "number", group: "worker", min: 0, max: 10000, step: 1 },
        { key: "taskTimeoutSeconds", label: "Task Timeout Seconds", type: "number", group: "worker", min: 1, max: 86400, step: 1 },
        { key: "toolTimeoutSeconds", label: "Tool Timeout Ms", type: "number", group: "worker", min: 1000, max: 3600000, step: 1000 },
        { key: "relayHost", label: "Relay Host", type: "text", group: "relay" },
        { key: "relayPort", label: "Relay Port", type: "number", group: "relay", min: 1, max: 65535, step: 1 },
        { key: "workerHost", label: "Worker Host", type: "text", group: "relay" },
        { key: "workerPort", label: "Worker Port", type: "number", group: "relay", min: 1, max: 65535, step: 1 }
      ]
    },
    routePreview: ["File/Shell tools/SubAgent", "Docker Pi Worker", "host-side LLM relay"],
    runtimeAccess: ["read and write only inside the Docker-visible sandbox", "use the selected Alice LLM preset through the dedicated relay"]
  };
}

function readPiWorkerConfigForAdmin(context: AdminRoutesContext): PiWorkerConfig {
  return readPiWorkerConfig(piWorkerConfigPath(context));
}

async function previewAdminPlugin(context: AdminRoutesContext, response: any, pluginId: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  if (!entry) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!entry.preview) {
    writeJson(response, 400, { ok: false, error: "plugin_preview_unavailable" });
    return;
  }
  let result: unknown;
  try {
    result = await entry.preview(context);
  } catch (error) {
    writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "plugin_preview_failed" });
    return;
  }
  if (result && typeof result === "object" && "error" in result && typeof result.error === "string") {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  writeJson(response, 200, { ok: true, ...(result && typeof result === "object" ? result : { result }) });
}

function piWorkerConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.piWorker?.configPath ?? "config/plugin/pi-worker/config.json";
}

function piWorkerStringField(patch: Record<string, unknown>, key: string, fallback: string): string {
  return patch[key] === undefined ? fallback : requiredString(patch[key]).trim();
}

function piWorkerNumberField(patch: Record<string, unknown>, key: string, fallback: number): number {
  return patch[key] === undefined ? fallback : Number(patch[key]);
}

function bashSandboxPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return {
        id: "bash_sandbox",
        name: "Bash Sandbox",
        kind: "tool",
        status: "enabled",
        health: "healthy",
        description: "Docker-backed bash tool sandbox.",
        configurable: true,
        switchable: false,
        configSource: bashSandboxEnvPath(context)
      };
    },
    config(context) {
      return publicBashSandboxConfig(readBashSandboxConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateBashSandboxConfig(context, patch);
      return "error" in result ? result : { config: publicBashSandboxConfig(result.config), restartRequired: true };
    },
    reload(context) {
      return { config: publicBashSandboxConfig(readBashSandboxConfigForAdmin(context)) };
    },
    configSchema: {
      groups: [
        { key: "runtime", label: "Runtime" },
        { key: "paths", label: "Paths" },
        { key: "limits", label: "Limits" },
        { key: "mounts", label: "Mounts" }
      ],
      fields: [
        { key: "network", label: "Network", type: "select", group: "runtime", options: [
          { value: "none", label: "none" },
          { value: "configured", label: "configured" }
        ], description: "Takes effect after Alice restarts. configured enables Docker bridge networking and inherited proxy env. The Pi Worker shares this container, so configured also gives the in-container Bash Docker bridge network access; Pi Worker requires configured and cannot be saved as none." },
        { key: "containerName", label: "Container Name", type: "text", group: "runtime" },
        { key: "image", label: "Image", type: "text", group: "runtime" },
        { key: "defaultCwd", label: "Default CWD", type: "text", group: "runtime" },
        { key: "hostWorkspaceDir", label: "Host Workspace Dir", type: "text", group: "paths" },
        { key: "workspaceDir", label: "Container Workspace Dir", type: "text", group: "paths" },
        { key: "hostCacheDir", label: "Host Cache Dir", type: "text", group: "paths" },
        { key: "cacheDir", label: "Container Cache Dir", type: "text", group: "paths" },
        { key: "skillsDir", label: "Container Skills Dir", type: "text", group: "paths" },
        { key: "tmpDir", label: "Container Tmp Dir", type: "text", group: "paths" },
        { key: "timeoutMs", label: "Timeout Ms", type: "number", group: "limits", min: 1000, max: 3600000, step: 1000 },
        { key: "outputLimitBytes", label: "Output Limit Bytes", type: "number", group: "limits", min: 1024, max: 10485760, step: 1024 },
        { key: "cpuLimit", label: "CPU Limit", type: "text", group: "limits", description: "Docker --cpus value. Blank removes the env override." },
        { key: "memoryLimit", label: "Memory Limit", type: "text", group: "limits", description: "Docker --memory value. Blank removes the env override." },
        { key: "pidsLimit", label: "PIDs Limit", type: "number", group: "limits", min: 1, max: 100000, step: 1 },
        { key: "mounts", label: "Mounts JSON", type: "textarea", group: "mounts", description: "JSON array of { id, hostPath, containerPath, readOnly }. Takes effect after restart." }
      ]
    },
    routePreview: [
      "bash tool call",
      "bash sandbox permission check",
      "Docker container",
      "stdout/stderr result"
    ],
    runtimeAccess: [
      "start or exec in the configured Docker container",
      "read/write configured workspace and cache mounts",
      "read optional mounts according to their readOnly flag",
      "network access only when BASH_SANDBOX_NETWORK=configured after restart",
      "configured also grants the in-container Bash Docker bridge networking because the Pi Worker shares this container"
    ]
  };
}

type BashSandboxPublicConfig = Omit<BashSandboxConfig, "skillMounts" | "piWorker"> & {
  piWorker?: Omit<PiWorkerContainerConfig, "workerToken">;
};

function publicBashSandboxConfig(config: BashSandboxConfig): BashSandboxPublicConfig {
  const { skillMounts: _skillMounts, piWorker, ...publicConfig } = config;
  if (!piWorker) return publicConfig;
  const { workerToken: _workerToken, ...publicPiWorker } = piWorker;
  return { ...publicConfig, piWorker: publicPiWorker };
}

function updateBashSandboxConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: BashSandboxConfig } | { error: string } {
  const current = readBashSandboxConfigForAdmin(context);
  const mounts = parseBashSandboxMountPatch(patch.mounts, current.mounts);
  if ("error" in mounts) return mounts;
  const networkValue = patch.network === undefined ? current.network : String(patch.network);
  if (networkValue !== "none" && networkValue !== "configured") return { error: "invalid_bash_sandbox_network" };
  const network: BashSandboxConfig["network"] = networkValue;
  const nextInput = {
    ...current,
    containerName: bashSandboxStringField(patch, "containerName", current.containerName),
    image: bashSandboxStringField(patch, "image", current.image),
    defaultCwd: bashSandboxStringField(patch, "defaultCwd", current.defaultCwd),
    hostWorkspaceDir: bashSandboxStringField(patch, "hostWorkspaceDir", current.hostWorkspaceDir),
    workspaceDir: bashSandboxStringField(patch, "workspaceDir", current.workspaceDir),
    hostCacheDir: bashSandboxStringField(patch, "hostCacheDir", current.hostCacheDir),
    cacheDir: bashSandboxStringField(patch, "cacheDir", current.cacheDir),
    skillsDir: bashSandboxStringField(patch, "skillsDir", current.skillsDir),
    notesDir: bashSandboxStringField(patch, "notesDir", current.notesDir),
    tmpDir: bashSandboxStringField(patch, "tmpDir", current.tmpDir),
    network,
    timeoutMs: bashSandboxNumberField(patch, "timeoutMs", current.timeoutMs, 1000, 3_600_000),
    outputLimitBytes: bashSandboxNumberField(patch, "outputLimitBytes", current.outputLimitBytes, 1024, 10 * 1024 * 1024),
    cpuLimit: bashSandboxOptionalStringField(patch, "cpuLimit", current.cpuLimit),
    memoryLimit: bashSandboxOptionalStringField(patch, "memoryLimit", current.memoryLimit),
    pidsLimit: bashSandboxOptionalNumberField(patch, "pidsLimit", current.pidsLimit, 1, 100_000),
    mounts: mounts.value
  };
  if (Object.values(nextInput).some((value) => value === "" || Number.isNaN(value))) return { error: "invalid_bash_sandbox_config" };
  try {
    const next = validateBashSandboxConfig(nextInput);
    writeBashSandboxEnv(context, next);
    return { config: next };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid_bash_sandbox_config" };
  }
}

function readBashSandboxConfigForAdmin(context: AdminRoutesContext): BashSandboxConfig {
  const env = readEnvFile(bashSandboxEnvPath(context));
  const current = context.config.bashSandbox;
  return validateBashSandboxConfig({
    ...current,
    containerName: env.BASH_SANDBOX_CONTAINER_NAME ?? current.containerName,
    image: env.BASH_SANDBOX_IMAGE ?? current.image,
    defaultCwd: env.BASH_SANDBOX_DEFAULT_CWD ?? current.defaultCwd,
    hostWorkspaceDir: env.BASH_SANDBOX_HOST_WORKSPACE_DIR ?? current.hostWorkspaceDir,
    workspaceDir: env.BASH_SANDBOX_WORKSPACE_DIR ?? current.workspaceDir,
    hostCacheDir: env.BASH_SANDBOX_HOST_CACHE_DIR ?? current.hostCacheDir,
    cacheDir: env.BASH_SANDBOX_CACHE_DIR ?? current.cacheDir,
    skillsDir: env.BASH_SANDBOX_SKILLS_DIR ?? current.skillsDir,
    notesDir: env.BASH_SANDBOX_NOTES_DIR ?? current.notesDir,
    tmpDir: env.BASH_SANDBOX_TMP_DIR ?? current.tmpDir,
    mounts: env.BASH_SANDBOX_MOUNTS === undefined ? current.mounts : parseBashSandboxMounts(JSON.parse(env.BASH_SANDBOX_MOUNTS)),
    network: env.BASH_SANDBOX_NETWORK === "none" ? "none" : "configured",
    timeoutMs: env.BASH_SANDBOX_TIMEOUT_MS === undefined ? current.timeoutMs : Number(env.BASH_SANDBOX_TIMEOUT_MS),
    outputLimitBytes: env.BASH_SANDBOX_OUTPUT_LIMIT_BYTES === undefined ? current.outputLimitBytes : Number(env.BASH_SANDBOX_OUTPUT_LIMIT_BYTES),
    cpuLimit: env.BASH_SANDBOX_CPU_LIMIT ?? current.cpuLimit,
    memoryLimit: env.BASH_SANDBOX_MEMORY_LIMIT ?? current.memoryLimit,
    pidsLimit: env.BASH_SANDBOX_PIDS_LIMIT === undefined ? current.pidsLimit : Number(env.BASH_SANDBOX_PIDS_LIMIT),
  });
}

function writeBashSandboxEnv(context: AdminRoutesContext, config: BashSandboxConfig): void {
  updateEnvFile(bashSandboxEnvPath(context), {
    BASH_SANDBOX_CONTAINER_NAME: config.containerName,
    BASH_SANDBOX_IMAGE: config.image,
    BASH_SANDBOX_DEFAULT_CWD: config.defaultCwd,
    BASH_SANDBOX_HOST_WORKSPACE_DIR: config.hostWorkspaceDir,
    BASH_SANDBOX_WORKSPACE_DIR: config.workspaceDir,
    BASH_SANDBOX_HOST_CACHE_DIR: config.hostCacheDir,
    BASH_SANDBOX_CACHE_DIR: config.cacheDir,
    BASH_SANDBOX_SKILLS_DIR: config.skillsDir,
    BASH_SANDBOX_NOTES_DIR: config.notesDir,
    BASH_SANDBOX_TMP_DIR: config.tmpDir,
    BASH_SANDBOX_MOUNTS: JSON.stringify(config.mounts),
    BASH_SANDBOX_NETWORK: config.network,
    BASH_SANDBOX_TIMEOUT_MS: String(config.timeoutMs),
    BASH_SANDBOX_OUTPUT_LIMIT_BYTES: String(config.outputLimitBytes),
    BASH_SANDBOX_CPU_LIMIT: config.cpuLimit ?? null,
    BASH_SANDBOX_MEMORY_LIMIT: config.memoryLimit ?? null,
    BASH_SANDBOX_PIDS_LIMIT: config.pidsLimit === undefined ? null : String(config.pidsLimit),
  });
}

function parseBashSandboxMountPatch(value: unknown, fallback: BashSandboxConfig["mounts"]): { value: BashSandboxConfig["mounts"] } | { error: string } {
  if (value === undefined) return { value: fallback };
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value;
    if (!Array.isArray(parsed)) return { error: "invalid_bash_sandbox_mounts" };
    return { value: parseBashSandboxMounts(parsed) };
  } catch {
    return { error: "invalid_bash_sandbox_mounts" };
  }
}

function bashSandboxStringField(patch: Record<string, unknown>, key: string, fallback: string): string {
  return patch[key] === undefined ? fallback : requiredString(patch[key]).trim();
}

function bashSandboxOptionalStringField(patch: Record<string, unknown>, key: string, fallback: string | undefined): string | undefined {
  if (patch[key] === undefined) return fallback;
  return optionalString(patch[key]);
}

function bashSandboxNumberField(patch: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = numberFromUnknown(patch[key], fallback);
  return Number.isFinite(value) && value >= min && value <= max ? value : Number.NaN;
}

function bashSandboxOptionalNumberField(patch: Record<string, unknown>, key: string, fallback: number | undefined, min: number, max: number): number | undefined {
  if (patch[key] === undefined) return fallback;
  if (patch[key] === "") return undefined;
  const value = Number(patch[key]);
  return Number.isFinite(value) && value >= min && value <= max ? value : Number.NaN;
}

function bashSandboxEnvPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.bashSandbox?.envPath ?? ".env";
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    env[trimmed.slice(0, separator).trim()] = unquoteEnvValue(trimmed.slice(separator + 1).trim());
  }
  return env;
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function writeAdminPluginConfig(context: AdminRoutesContext, response: any, pluginId: string): void {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.config) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  writeJson(response, 200, adminPluginConfigPayload(context, entry));
}

async function patchAdminPluginConfig(context: AdminRoutesContext, request: any, response: any, pluginId: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.patch) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const body = await readJsonBody(request);
  const result = await entry.patch(context, body);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} config saved`);
  writeJson(response, 200, {
    ok: true,
    restartRequired: Boolean(result.restartRequired),
    plugin: entry.summary(context),
    configValue: result.config
  });
}

async function setAdminPluginEnabled(context: AdminRoutesContext, response: any, pluginId: string, enabled: boolean): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.switchable || !entry?.setEnabled) {
    writeJson(response, 400, { ok: false, error: "plugin_not_switchable" });
    return;
  }
  const result = entry.setEnabled(context, enabled);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} ${enabled ? "enabled" : "disabled"}`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    configValue: result.config
  });
}

function reloadAdminPlugin(context: AdminRoutesContext, response: any, pluginId: string): void {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!plugin.configurable || !entry?.reload) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const result = entry.reload(context);
  if ("error" in result) {
    writeJson(response, 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} config reloaded`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    configValue: result.config
  });
}

async function testAdminPlugin(context: AdminRoutesContext, request: any, response: any, pluginId: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!entry?.test) {
    writeJson(response, 400, { ok: false, error: "plugin_test_unavailable" });
    return;
  }
  const body = await readJsonBody(request);
  const result = await entry.test(context, body);
  writeJson(response, "error" in result ? 400 : 200, "error" in result ? { ok: false, error: result.error } : result);
}

function writeAdminPluginEvents(context: AdminRoutesContext, response: any, pluginId: string): void {
  const plugin = findAdminPluginEntry(context, pluginId)?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  writeJson(response, 200, { events: listAdminPluginEvents(context, pluginId) });
}

async function uploadAdminPluginAsset(context: AdminRoutesContext, request: any, response: any, pluginId: string, assetKey: string): Promise<void> {
  const entry = findAdminPluginEntry(context, pluginId);
  const plugin = entry?.summary(context);
  if (!plugin) {
    writeJson(response, 404, { ok: false, error: "plugin_not_found" });
    return;
  }
  if (!entry?.uploadAsset) {
    writeJson(response, 400, { ok: false, error: "plugin_not_configurable" });
    return;
  }
  const result = await entry.uploadAsset(context, assetKey, request);
  if ("error" in result) {
    writeJson(response, result.statusCode ?? 400, { ok: false, error: result.error });
    return;
  }
  context.appendLog("info", `plugin ${plugin.id} asset uploaded: ${assetKey} -> ${result.assetPath}`);
  writeJson(response, 200, {
    ok: true,
    plugin: entry.summary(context),
    assetPath: result.assetPath,
    configValue: result.config
  });
}

function adminPluginConfigPayload(context: AdminRoutesContext, entry: AdminPluginRegistryEntry): unknown {
  const plugin = entry.summary(context);
  const configValue = entry.config?.(context) ?? {};
  const configSchema = withDynamicPluginConfigSchema(context, plugin.id, entry.configSchema ?? { fields: [] }, configValue);
  return {
    plugin: {
      ...plugin,
      version: "local"
    },
    configSchema,
    configValue,
    runtimeState: entry.runtimeState?.(context),
    apiPresets: publicLLMApiPresets(readLLMApiPresets(context)),
    routePreview: entry.routePreview ?? [],
    runtimeAccess: entry.runtimeAccess ?? [],
    testSchema: entry.testSchema
  };
}

function withDynamicPluginConfigSchema(context: AdminRoutesContext, pluginId: string, schema: NonNullable<AdminPluginRegistryEntry["configSchema"]>, configValue: unknown): NonNullable<AdminPluginRegistryEntry["configSchema"]> {
  if (pluginId === "pi_worker") {
    return {
      ...schema,
      fields: schema.fields.map((field) => field.key === "llmPresetName"
        ? { ...field, options: publicLLMApiPresets(readLLMApiPresets(context)).map((preset) => ({ value: preset.name, label: preset.name })) }
        : field)
    };
  }
  if (pluginId !== "tts") return schema;
  const config = configValue as TtsAdminConfig;
  const translationNames = Object.keys(config.translationPresets ?? {});
  const presetNames = Object.keys(config.presets ?? {});
  return {
    ...schema,
    fields: schema.fields.map((field) => field.key === "translationPresetName" || field.key === "translationEditPresetName"
      ? {
        ...field,
        options: translationNames.map((name) => ({ value: name, label: name }))
      }
      : field.key === "activePresetName" || field.key === "editPresetName" || field.key === "corePresetName" || field.key === "shellPresetName"
      ? {
        ...field,
        options: presetNames.map((name) => ({ value: name, label: name }))
      }
      : field)
  };
}


function listAdminPluginEvents(context: AdminRoutesContext, pluginId: string): unknown[] {
  const aliases = [pluginId, pluginId.replace(/-/g, " "), pluginId.replace(/-/g, "_")];
  return context.logs
    .filter((entry): entry is { id?: number; time?: string; level?: "info" | "warn" | "error"; message: string } => {
      if (!entry || typeof entry !== "object") return false;
      const message = (entry as { message?: unknown }).message;
      return typeof message === "string" && aliases.some((alias) => message.toLowerCase().includes(alias));
    })
    .slice(-50)
    .reverse()
    .map((entry) => ({
      id: entry.id,
      time: entry.time,
      level: entry.level,
      message: entry.message
    }));
}
