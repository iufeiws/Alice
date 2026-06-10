import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { AliceStore, InsertOutboundMessageInput } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import type { AgentOutput, ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { buildLLMTextVariables, renderLLMText } from "../../../../contexts/agent-profile/src/ports/prompt-rendering.js";

const childProcess = await import("node:child_process");
const fs = await import("node:fs");
const moduleApi = await import("node:module");
const path = await import("node:path");
const require = moduleApi.createRequire(import.meta.url);

export type PhotoToolTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type SelfieContext = {
  mainPrompt: string;
  appearanceDescription?: string;
  personalityName: string;
  personalityContent: string;
  outfitId: string;
  outfitName: string;
  outfitContent: string;
  outfitImageUrl?: string;
};

export type SelfieExecutorInput = {
  command: string;
  workDir: string;
  fileName: string;
  prompt: string;
  referenceImages: string[];
  referenceImagePrompt: string;
  aspectRatio: SelfieAspectRatio;
  timeoutMs: number;
  apiKey?: string;
  apiBaseURL: string;
  apiModel: string;
  apiSize: string;
  apiQuality: string;
  apiOutputFormat: string;
  apiOutputCompression: number;
  apiTimeoutMs: number;
  proxyUrl?: string;
};

export type SelfieExecutorResult = {
  stdout?: string;
  stderr?: string;
  lastMessage?: string;
  events?: string;
};

export type SelfieExecutor = (input: SelfieExecutorInput) => Promise<SelfieExecutorResult | void>;

export type SelfieGenerationMode = "api" | "codex";

export type PhotoPluginConfig = {
  enabled: boolean;
  selfieMode: SelfieGenerationMode;
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

export type PhotoPluginPublicConfig = Omit<PhotoPluginConfig, "selfieImageApiKey"> & {
  selfieImageApiKeySet: boolean;
};

export type PhotoToolsDeps = {
  store: Pick<AliceStore, "insertOutboundMessage" | "markOutboundMessageSent" | "markOutboundMessageFailed">;
  outputRouter: Pick<OutputRouter, "send">;
  time?: CurrentTimeProvider;
  selfieConfigPath?: string;
  selfieReferenceDir?: string;
  selfieOutputDir?: string;
  selfieAssetRoot?: string;
  selfieCodexCommand?: string;
  selfieCodexTimeoutMs?: number;
  selfieImageApiKey?: string;
  selfieImageApiBaseURL?: string;
  selfieImageApiModel?: string;
  selfieImageApiSize?: string;
  selfieImageApiQuality?: string;
  selfieImageApiOutputFormat?: string;
  selfieImageApiOutputCompression?: number;
  selfieImageApiTimeoutMs?: number;
  selfieMaxBytes?: number;
  selfieExecutor?: SelfieExecutor;
  getSelfieContext?(): SelfieContext;
  getUserName?: () => string;
  getAppearanceDescription?: () => string;
  getDefaultTarget?(): PhotoToolTarget | undefined;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog?(input: {
    direction: "outbound";
    plugin: string;
    kind: string;
    target?: string;
    sessionId?: string;
    status?: string;
    summary: string;
    error?: string;
  }): unknown;
};

type SelfieAspectRatio = "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

const allowedAspectRatios = new Set<SelfieAspectRatio>(["1:1", "4:3", "3:4", "16:9", "9:16"]);
const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const selfiePromptFileName = "selfie-prompt.txt";
const characterReferenceFileName = "alice-character-reference.png";
const libraryReferenceFileName = "magic-library-reference.png";
const defaultFastSelfieRunner = path.resolve("src/capabilities/skills/external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs");
export const defaultPhotoPluginConfigPath = "config/plugin/photo/config.json";

export function createPhotoTools(deps: PhotoToolsDeps): ToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;

  return {
    id: "photo",
    listTools() {
      return [selfieTool];
    },
    async execute(call) {
      if (call.toolName === "selfie") return selfie(call);
      return { callId: call.id, ok: false, error: `Unknown photo tool: ${call.toolName}` };
    }
  };

  async function selfie(call: ToolCall): Promise<ToolResult> {
    const photoConfig = runtimePhotoConfig();
    if (!photoConfig.enabled) return toolError(call, "photo selfie is disabled");

    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");

    const action = (stringValue(call.input.action) || stringValue(call.input.description)).trim();
    if (!action) return toolError(call, "action is required");

    const aspectRatio = normalizeAspectRatio(call.input.aspectRatio);
    if (!aspectRatio) return toolError(call, "unsupported aspectRatio");

    const context = deps.getSelfieContext?.();
    if (!context) return toolError(call, "selfie context is not available");

    const imageApiOutputFormat = normalizeOutputFormat(photoConfig.selfieImageApiOutputFormat);
    const fullOutputDir = path.resolve(photoConfig.selfieOutputDir);
    const assetRoot = path.resolve(deps.selfieAssetRoot ?? "assets");
    const relativeDir = path.relative(assetRoot, fullOutputDir);
    if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
      return toolError(call, "selfie output directory must be inside assets");
    }

    let tempDir: string | undefined;
    let codexResult: SelfieExecutorResult | undefined;
    try {
      fs.mkdirSync(fullOutputDir, { recursive: true });
      tempDir = path.join(fullOutputDir, `.tmp_${time.now().epochMs}_${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const fileName = `selfie_${formatFileDateTime(time.now().iso)}.${extensionForOutputFormat(imageApiOutputFormat)}`;
      const tempFilePath = path.resolve(tempDir, fileName);
      const finalFilePath = path.resolve(fullOutputDir, fileName);
      const assetId = path.join(relativeDir, fileName);

      await sendText(target, "-少女拍照中-", "system");
      const prompt = buildSelfiePrompt(action, context);
      const references = resolveReferenceImages(context);
      deps.appendLog?.("info", [
        "selfie generation start:",
        `workDir=${tempDir}`,
        `file=${fileName}`,
        `mode=${photoConfig.selfieMode}`,
        `aspectRatio=${aspectRatio}`,
        `promptLength=${prompt.length}`,
        `images=${references.images.map((image) => path.basename(image)).join(",")}`,
        references.missingOutfitImage ? "missingOutfitImage=true" : ""
      ].join(" "));
      const executor = deps.selfieExecutor ?? selfieExecutorForMode(photoConfig.selfieMode);
      const executorResult = await executor({
        command: photoConfig.selfieCodexCommand,
        workDir: tempDir,
        fileName,
        prompt,
        referenceImages: references.images,
        referenceImagePrompt: references.prompt,
        aspectRatio,
        timeoutMs: photoConfig.selfieCodexTimeoutMs,
        apiKey: photoConfig.selfieImageApiKey,
        apiBaseURL: photoConfig.selfieImageApiBaseURL,
        apiModel: photoConfig.selfieImageApiModel,
        apiSize: photoConfig.selfieImageApiSize,
        apiQuality: photoConfig.selfieImageApiQuality,
        apiOutputFormat: imageApiOutputFormat,
        apiOutputCompression: photoConfig.selfieImageApiOutputCompression,
        apiTimeoutMs: photoConfig.selfieImageApiTimeoutMs,
        proxyUrl
      });
      if (executorResult) codexResult = executorResult;
      deps.appendLog?.("info", [
        "selfie generator finished:",
        `workDir=${tempDir}`,
        `stdout=${excerpt(codexResult?.stdout)}`,
        `stderr=${excerpt(codexResult?.stderr)}`,
        `lastMessage=${excerpt(codexResult?.lastMessage, 1000)}`,
        `events=${excerpt(codexResult?.events, 1500)}`,
        `files=${listDirForLog(tempDir)}`
      ].join(" "));

      validateGeneratedImage(tempFilePath, tempDir, photoConfig.selfieMaxBytes);
      fs.renameSync(tempFilePath, finalFilePath);
      validateGeneratedImage(finalFilePath, fullOutputDir, photoConfig.selfieMaxBytes);

      const sent = await sendImage(target, assetId);
      deps.appendLog?.("info", `selfie generation sent: assetId=${assetId} messageId=${extractSentMessageId(sent) ?? ""}`);
      return {
        callId: call.id,
        ok: true,
        output: {
          assetId,
          path: finalFilePath,
          sent: true,
          messageId: extractSentMessageId(sent)
        }
      };
    } catch (error) {
      const reason = [
        error instanceof Error ? error.message : String(error),
        codexResult?.stdout ? `generator stdout: ${excerpt(codexResult.stdout, 1000)}` : "",
        codexResult?.stderr ? `generator stderr: ${excerpt(codexResult.stderr, 1000)}` : "",
        codexResult?.lastMessage ? `generator last message: ${excerpt(codexResult.lastMessage, 1500)}` : "",
        codexResult?.events ? `generator events: ${excerpt(codexResult.events, 1500)}` : ""
      ].filter(Boolean).join("\n");
      deps.appendLog?.("warn", `selfie generation failed: ${reason}${tempDir ? ` files=${listDirForLog(tempDir)}` : ""}`);
      await sendSelfieFailureNotice(target);
      return toolError(call, reason);
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  function buildSelfiePrompt(action: string, context: SelfieContext): string {
    const referenceDir = runtimePhotoConfig().selfieReferenceDir;
    const templatePath = path.resolve(referenceDir, selfiePromptFileName);
    if (!fs.existsSync(templatePath)) throw new Error("selfie prompt template was not found");
    const template = fs.readFileSync(templatePath, "utf8");
    const now = time.now();
    return renderLLMText(template, {
      ...buildLLMTextVariables({
        userName: deps.getUserName?.() || "user",
        time,
        appearanceDescription: deps.getAppearanceDescription?.() ?? context.appearanceDescription ?? "",
        dailyShellRaw: {
          date: now.iso.slice(0, 10),
          dateUtc: now.date.toISOString().slice(0, 10),
          createdAt: now.iso,
          createdAtUtc: now.date.toISOString(),
          personality: {
            id: context.personalityName,
            name: context.personalityName,
            content: context.personalityContent
          },
          relationship: {
            id: "",
            name: "",
            content: ""
          },
          outfit: {
            id: context.outfitId,
            name: context.outfitName,
            content: context.outfitContent,
            ...(context.outfitImageUrl ? { imageUrl: context.outfitImageUrl } : {})
          }
        }
      }),
      user: deps.getUserName?.() || "user",
      action,
    });
  }

  function resolveReferenceImages(context: SelfieContext): { images: string[]; prompt: string; missingOutfitImage: boolean } {
    const referenceDir = runtimePhotoConfig().selfieReferenceDir;
    const characterImage = requireFile(path.resolve(referenceDir, characterReferenceFileName), "selfie character reference image was not found");
    const libraryImage = requireFile(path.resolve(referenceDir, libraryReferenceFileName), "selfie library reference image was not found");
    const outfitImage = optionalFile(resolveOutfitImage(context));
    if (outfitImage) {
      return {
        images: [characterImage, outfitImage, libraryImage],
        prompt: "输入图片顺序: 图1为角色参考，图2为今日服装参考，图3为图书馆场景参考。",
        missingOutfitImage: false
      };
    }
    return {
      images: [characterImage, libraryImage],
      prompt: "输入图片顺序: 图1为角色参考，图2为图书馆场景参考。今日服装只使用文字描述，不提供服装参考图。",
      missingOutfitImage: true
    };
  }

  async function sendText(target: PhotoToolTarget, text: string, senderRole: "assistant" | "system" = "assistant"): Promise<unknown> {
    const now = time.now();
    return sendOutput({
      id: createId("tool_out"),
      target: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId,
        sessionId: target.sessionId
      },
      content: { kind: "text", text },
      meta: {
        createdAt: now.iso,
        createdAtUtc: now.date.toISOString(),
        urgency: "normal",
        allowStreaming: false
      }
    }, senderRole);
  }

  async function sendImage(target: PhotoToolTarget, assetId: string): Promise<unknown> {
    const now = time.now();
    return sendOutput({
      id: createId("tool_out"),
      target: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId,
        sessionId: target.sessionId
      },
      content: { kind: "image", assetId },
      meta: {
        createdAt: now.iso,
        createdAtUtc: now.date.toISOString(),
        urgency: "normal",
        allowStreaming: false
      }
    });
  }

  async function sendSelfieFailureNotice(target: PhotoToolTarget): Promise<void> {
    try {
      await sendText(target, "-大失败-", "system");
    } catch (error) {
      deps.appendLog?.("warn", `selfie failure notice failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function sendOutput(output: AgentOutput, senderRole: "assistant" | "system" = "assistant"): Promise<unknown> {
    const stored = deps.store.insertOutboundMessage(toStoredOutbound(output, senderRole));
    try {
      const sent = await deps.outputRouter.send(output);
      deps.store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), time.now().date.toISOString(), extractSentMessageCreatedAtUtc(sent));
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "sent",
        summary: summarizeOutput(output)
      });
      return sent;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failedTime = time.now();
      deps.store.markOutboundMessageFailed(stored.id, failedTime.iso, reason, failedTime.date.toISOString());
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "send_failed",
        summary: summarizeOutput(output),
        error: reason
      });
      throw error;
    }
  }

  function resolveTarget(call: ToolCall): PhotoToolTarget | undefined {
    if (call.requester?.plugin && call.session?.sessionId) {
      return normalizeTarget({
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.session.sessionId
      });
    }
    const target = deps.getDefaultTarget?.();
    return target ? normalizeTarget(target) : undefined;
  }

  function runtimePhotoConfig(): PhotoPluginConfig {
    const defaults = photoConfigDefaultsFromDeps(deps);
    return deps.selfieConfigPath
      ? readPhotoPluginConfig(deps.selfieConfigPath, defaults)
      : normalizePhotoPluginConfig({}, defaults);
  }
}

const selfieTool: ToolDefinition = {
  name: "selfie",
  description: "自拍。根据 action 动作描述，结合爱丽丝角色特征、今日外壳和参考图生成一张自拍/照片并自动发送到当前聊天；默认 aspectRatio 为 3:4。调用后不要再用 send_chat 发送同一张图。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string" },
      aspectRatio: {
        type: "string",
        enum: ["1:1", "4:3", "3:4", "16:9", "9:16"],
        default: "3:4"
      }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export function readPhotoPluginConfig(configPath?: string, defaults: Partial<PhotoPluginConfig> = {}): PhotoPluginConfig {
  let parsed: Record<string, unknown> = {};
  if (configPath) {
    const resolved = path.resolve(configPath);
    parsed = parseJsonObject(fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}");
  }
  return normalizePhotoPluginConfig(parsed, defaults);
}

export function publicPhotoPluginConfig(config: PhotoPluginConfig): PhotoPluginPublicConfig {
  const { selfieImageApiKey, ...publicConfig } = config;
  return {
    ...publicConfig,
    selfieImageApiKeySet: Boolean(selfieImageApiKey)
  };
}

function normalizePhotoPluginConfig(parsed: Record<string, unknown>, defaults: Partial<PhotoPluginConfig> = {}): PhotoPluginConfig {
  return {
    enabled: booleanValue(parsed.enabled, defaults.enabled ?? true),
    selfieMode: selfieModeValue(parsed.selfieMode, defaults.selfieMode ?? "api"),
    selfieReferenceDir: stringConfigValue(parsed.selfieReferenceDir, defaults.selfieReferenceDir ?? "assets/selfie/references"),
    selfieOutputDir: stringConfigValue(parsed.selfieOutputDir, defaults.selfieOutputDir ?? "assets/generated/selfies"),
    selfieCodexCommand: stringConfigValue(parsed.selfieCodexCommand, defaults.selfieCodexCommand ?? "codex"),
    selfieCodexTimeoutMs: numberValue(parsed.selfieCodexTimeoutMs, defaults.selfieCodexTimeoutMs ?? 180_000),
    selfieImageApiKey: stringConfigValue(parsed.selfieImageApiKey, defaults.selfieImageApiKey),
    selfieImageApiBaseURL: stringConfigValue(parsed.selfieImageApiBaseURL, defaults.selfieImageApiBaseURL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    selfieImageApiModel: stringConfigValue(parsed.selfieImageApiModel, defaults.selfieImageApiModel ?? "gpt-image-2"),
    selfieImageApiSize: stringConfigValue(parsed.selfieImageApiSize, defaults.selfieImageApiSize ?? "768x1024"),
    selfieImageApiQuality: stringConfigValue(parsed.selfieImageApiQuality, defaults.selfieImageApiQuality ?? "low"),
    selfieImageApiOutputFormat: normalizeOutputFormat(stringConfigValue(parsed.selfieImageApiOutputFormat, defaults.selfieImageApiOutputFormat ?? "jpeg")),
    selfieImageApiOutputCompression: numberValue(parsed.selfieImageApiOutputCompression, defaults.selfieImageApiOutputCompression ?? 45),
    selfieImageApiTimeoutMs: numberValue(parsed.selfieImageApiTimeoutMs, defaults.selfieImageApiTimeoutMs ?? 120_000),
    selfieMaxBytes: numberValue(parsed.selfieMaxBytes, defaults.selfieMaxBytes ?? 10 * 1024 * 1024)
  };
}

function photoConfigDefaultsFromDeps(deps: PhotoToolsDeps): Partial<PhotoPluginConfig> {
  return {
    enabled: true,
    selfieMode: "api",
    selfieReferenceDir: deps.selfieReferenceDir,
    selfieOutputDir: deps.selfieOutputDir,
    selfieCodexCommand: deps.selfieCodexCommand,
    selfieCodexTimeoutMs: deps.selfieCodexTimeoutMs,
    selfieImageApiKey: deps.selfieImageApiKey,
    selfieImageApiBaseURL: deps.selfieImageApiBaseURL,
    selfieImageApiModel: deps.selfieImageApiModel,
    selfieImageApiSize: deps.selfieImageApiSize,
    selfieImageApiQuality: deps.selfieImageApiQuality,
    selfieImageApiOutputFormat: deps.selfieImageApiOutputFormat,
    selfieImageApiOutputCompression: deps.selfieImageApiOutputCompression,
    selfieImageApiTimeoutMs: deps.selfieImageApiTimeoutMs,
    selfieMaxBytes: deps.selfieMaxBytes
  };
}

function selfieExecutorForMode(mode: SelfieGenerationMode): SelfieExecutor {
  return mode === "codex" ? runAliceSelfieFastSkill : runImageApiSelfie;
}

async function runImageApiSelfie(input: SelfieExecutorInput): Promise<SelfieExecutorResult> {
  if (!input.apiKey) throw new Error("selfie Image API key is not configured; set OPENAI_API_KEY or SELFIE_IMAGE_API_KEY");
  const prompt = [
    input.prompt,
    "",
    `画幅比例: ${input.aspectRatio}`,
    `API生成约束: 生成一张低质量快速草稿，尺寸目标 ${input.apiSize}，不要高清，不要高精细细节，不要多版本探索。`,
    input.referenceImagePrompt
  ].join("\n");
  const form = new FormData();
  form.append("model", input.apiModel);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", input.apiSize);
  form.append("quality", input.apiQuality);
  form.append("output_format", input.apiOutputFormat);
  if (input.apiOutputFormat === "jpeg" || input.apiOutputFormat === "webp") {
    form.append("output_compression", String(input.apiOutputCompression));
  }
  for (const image of input.referenceImages) {
    form.append("image[]", fileBlob(image), path.basename(image));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.apiTimeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${input.apiBaseURL}/images/edits`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.apiKey}`
      },
      body: form,
      ...dispatcherInit(input.proxyUrl)
    });
    const elapsedMs = Date.now() - started;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Image API failed after ${elapsedMs}ms: HTTP ${response.status} ${response.statusText} ${excerpt(body, 2000)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new Error(`Image API returned non-JSON after ${elapsedMs}ms: ${excerpt(body, 2000)}`);
    }
    const imageB64 = extractImageB64(payload);
    if (!imageB64) {
      throw new Error(`Image API returned no image after ${elapsedMs}ms: ${excerpt(JSON.stringify(payload), 2000)}`);
    }
    fs.writeFileSync(path.join(input.workDir, input.fileName), Buffer.from(imageB64, "base64"));
    return {
      stdout: `Image API completed in ${elapsedMs}ms; file=${input.fileName}`,
      stderr: "",
      lastMessage: `Image API completed in ${elapsedMs}ms`
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Image API selfie generation timed out after ${input.apiTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runAliceSelfieFastSkill(input: SelfieExecutorInput): Promise<SelfieExecutorResult> {
  const runnerPath = process.env.ALICE_SELFIE_FAST_RUNNER ?? defaultFastSelfieRunner;
  const configPath = path.join(input.workDir, "alice-selfie-fast-input.json");
  fs.writeFileSync(configPath, JSON.stringify({
    workDir: input.workDir,
    fileName: input.fileName,
    prompt: input.prompt,
    referenceImages: input.referenceImages,
    referenceImagePrompt: input.referenceImagePrompt,
    aspectRatio: input.aspectRatio,
    apiBaseURL: input.apiBaseURL,
    apiModel: input.apiModel,
    apiSize: input.apiSize,
    apiQuality: input.apiQuality,
    apiOutputFormat: input.apiOutputFormat,
    apiOutputCompression: input.apiOutputCompression,
    apiTimeoutMs: input.apiTimeoutMs,
    proxyUrl: input.proxyUrl
  }));
  const result = await execFile("node", [runnerPath, "--tool-input", configPath], input.timeoutMs, {
    SELFIE_IMAGE_API_KEY: input.apiKey ?? ""
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    lastMessage: excerpt(result.stderr || result.stdout, 1000)
  };
}

async function runCodexSelfie(input: SelfieExecutorInput): Promise<SelfieExecutorResult> {
  const prompt = [
    input.prompt,
    "",
    `画幅比例: ${input.aspectRatio}`,
    "速度优先：生成低质量草稿即可，不要高清，不要高精细细节，不要做多版本探索。",
    input.referenceImagePrompt,
    "输出尺寸目标: 768x1024 像素附近，保持 3:4 竖图；文件尽量小。",
    "输出格式: JPEG/JPG。",
    `请将最终图片保存为当前工作目录下的 ${input.fileName}。`,
    "只生成这一张图片，不要修改其他文件，不要创建额外文件。"
  ].join("\n");
  const imageArgs = input.referenceImages.map((image) => `--image=${image}`);
  const lastMessagePath = path.join(input.workDir, "codex-last-message.txt");

  const result = await execFile(input.command, [
    "exec",
    "-C",
    input.workDir,
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--json",
    "--output-last-message",
    lastMessagePath,
    ...imageArgs,
    prompt
  ], input.timeoutMs);
  return {
    ...result,
    lastMessage: fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, "utf8") : undefined,
    events: result.stdout
  };
}

function execFile(command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = {}): Promise<SelfieExecutorResult> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      child.kill("SIGTERM");
      const detail = [
        `selfie generation timed out after ${timeoutMs}ms`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : "",
        stdout.trim() ? `stdout/events: ${stdout.trim()}` : ""
      ].filter(Boolean).join("\n");
      reject(new Error(detail));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const detail = [`selfie generator exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`, stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(detail || "codex selfie generation failed"));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end();
  });
}

function validateGeneratedImage(filePath: string, outputDir: string, maxBytes: number): void {
  const relative = path.relative(outputDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("generated selfie path is outside output directory");
  }
  if (!allowedExtensions.has(path.extname(filePath).toLowerCase())) {
    throw new Error("generated selfie extension is not allowed");
  }
  let stat: { isFile(): boolean; size: number };
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`generated selfie file was not found at expected name ${path.basename(filePath)}; workdir files: ${listDirForLog(outputDir)}`);
  }
  if (!stat.isFile()) throw new Error("generated selfie path is not a file");
  if (stat.size > maxBytes) throw new Error("generated selfie file is too large");
}

function fileBlob(filePath: string): Blob {
  return new Blob([fs.readFileSync(filePath)], { type: contentType(filePath) });
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function extractImageB64(payload: unknown): string | undefined {
  const record = payload && typeof payload === "object" ? payload as { data?: unknown } : undefined;
  const data = Array.isArray(record?.data) ? record.data : [];
  const first = data[0] && typeof data[0] === "object" ? data[0] as { b64_json?: unknown } : undefined;
  return typeof first?.b64_json === "string" ? first.b64_json : undefined;
}

function dispatcherInit(proxyUrl: string | undefined): RequestInit {
  if (!proxyUrl) return {};
  const { ProxyAgent } = loadUndici();
  return { dispatcher: new ProxyAgent(proxyUrl) } as unknown as RequestInit;
}

function loadUndici(): { ProxyAgent: new (url: string) => unknown } {
  try {
    return require("undici") as { ProxyAgent: new (url: string) => unknown };
  } catch {
    return require("/usr/share/nodejs/undici") as { ProxyAgent: new (url: string) => unknown };
  }
}

function normalizeOutputFormat(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "jpg") return "jpeg";
  if (normalized === "jpeg" || normalized === "png" || normalized === "webp") return normalized;
  return "jpeg";
}

function selfieModeValue(value: unknown, fallback: SelfieGenerationMode): SelfieGenerationMode {
  return value === "codex" ? "codex" : value === "api" ? "api" : fallback;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringConfigValue(value: unknown, fallback: string | undefined): string {
  const text = stringValue(value).trim();
  return text || fallback || "";
}

function numberValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return Boolean(value);
}

function extensionForOutputFormat(value: string): string {
  return value === "jpeg" ? "jpg" : value;
}

function resolveOutfitImage(context: SelfieContext): string {
  const imageUrl = context.outfitImageUrl?.trim();
  if (imageUrl) return path.resolve(imageUrl);
  return path.resolve("memory-files", "shell", "outfits", `${safeFilePart(context.outfitId)}.jpg`);
}

function requireFile(filePath: string, error: string): string {
  if (!fs.existsSync(filePath)) throw new Error(error);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(error);
  return filePath;
}

function optionalFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return fs.statSync(filePath).isFile() ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function extractCharacterFeatures(mainPrompt: string): string {
  const match = /外貌特征:\s*([\s\S]*?)(?:\n\s*\n|你与\s*<user>|你的默认语言特征|$)/.exec(mainPrompt);
  if (match?.[1]?.trim()) return `外貌特征:\n${match[1].trim()}`;
  return [
    "外貌特征:",
    "发色: 低饱和浅金色",
    "发型: 长发及腰，发尾有自然的卷曲，额前留着整齐的刘海",
    "耳朵: 尖长的精灵耳",
    "眼睛: 浅金色",
    "体型: 少女体型，身体尚未完全长开",
    "身高: 155cm"
  ].join("\n");
}

function formatNamedBlock(name: string, content: string): string {
  return [name, content].map((part) => part.trim()).filter(Boolean).join("\n");
}

function listDirForLog(dirPath: string): string {
  try {
    const files = fs.readdirSync(dirPath);
    return files.length > 0 ? files.slice(0, 20).join(",") : "(empty)";
  } catch {
    return "(unreadable)";
  }
}

function excerpt(value: string | undefined, maxLength = 500): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function normalizeAspectRatio(value: unknown): SelfieAspectRatio | undefined {
  const text = stringValue(value) || "3:4";
  return allowedAspectRatios.has(text as SelfieAspectRatio) ? text as SelfieAspectRatio : undefined;
}

function normalizeTarget(target: PhotoToolTarget): PhotoToolTarget {
  if (target.plugin !== "feishu") return target;
  const normalizedChannelId = normalizeFeishuChatId(target.channelId);
  const normalizedUserId = normalizedChannelId ? target.userId : normalizeFeishuOpenId(target.userId ?? target.channelId);
  return {
    ...target,
    channelId: normalizedChannelId,
    userId: normalizedUserId
  };
}

function normalizeFeishuChatId(value: string | undefined): string | undefined {
  const unwrapped = unwrapFeishuInternalId(value);
  if (!unwrapped) return undefined;
  return unwrapped.prefixed && !unwrapped.id.startsWith("oc_") ? undefined : unwrapped.id;
}

function normalizeFeishuOpenId(value: string | undefined): string | undefined {
  const unwrapped = unwrapFeishuInternalId(value);
  if (!unwrapped) return undefined;
  return unwrapped.prefixed && unwrapped.id.startsWith("oc_") ? undefined : unwrapped.id;
}

function unwrapFeishuInternalId(value: string | undefined): { id: string; prefixed: boolean } | undefined {
  if (!value) return undefined;
  const match = /^feishu:(?:dm|group):(.+)$/.exec(value);
  return match ? { id: match[1], prefixed: true } : { id: value, prefixed: false };
}

function toStoredOutbound(output: AgentOutput, senderRole: "assistant" | "system" = "assistant"): InsertOutboundMessageInput {
  return {
    plugin: output.target.plugin,
    conversationId: output.target.sessionId,
    senderRole,
    contentType: output.content.kind,
    contentText: summarizeOutput(output),
    contentJson: JSON.stringify(output.content),
    createdAt: output.meta.createdAt,
    createdAtUtc: output.meta.createdAtUtc
  };
}

function summarizeOutput(output: AgentOutput): string {
  const content = output.content;
  if (content.kind === "image" || content.kind === "audio") return content.assetId;
  if (content.kind === "file") return content.filename || content.assetId;
  if (content.kind === "text") return content.text;
  if (content.kind === "markdown") return content.markdown;
  if (content.kind === "card") return content.card.title;
  return content.kind;
}

function extractSentMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { messageId?: unknown };
  return typeof record.messageId === "string" ? record.messageId : undefined;
}

function extractSentMessageCreatedAtUtc(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { createdAtUtc?: unknown };
  return typeof record.createdAtUtc === "string" ? record.createdAtUtc : undefined;
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "selfie";
}

function formatFileDateTime(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) return String(Date.now());
  const [, year, month, day, hour, minute, second] = match;
  return `${year}${month}${day}_${hour}${minute}${second}`;
}

function formatPromptTime(iso: string, timeZone: string): string {
  const value = iso.replace("T", " ").replace(/\.\d{3}$/, "");
  return `${value} ${timeZone}`;
}
