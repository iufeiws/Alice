import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { AliceStore, InsertOutboundMessageInput } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import type { AgentOutput, ToolCall, ToolDefinition, ToolExecutionContext, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
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
  codexWorkDir?: string;
  fileName: string;
  prompt: string;
  referenceImages: string[];
  referenceImagePrompt: string;
  aspectRatio: SelfieAspectRatio;
  timeoutMs: number;
  apiKey?: string;
  apiBaseURL: string;
  apiEndpoint: "edits" | "relayEdits" | "generations";
  apiModel: string;
  apiSize: string;
  apiQuality: string;
  apiModeration: string;
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

export type SelfieGenerationMode = "api" | "codex" | "openaiRelay";

export type PhotoPluginConfig = {
  enabled: boolean;
  selfieMode: SelfieGenerationMode;
  selfieReferenceDir: string;
  selfieOutputDir: string;
  selfieCodexCommand: string;
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
};

export type PhotoPluginPublicConfig = Omit<PhotoPluginConfig, "selfieImageApiKey" | "selfieImageApiRelayKey"> & {
  selfieImageApiKeySet: boolean;
  selfieImageApiRelayKeySet: boolean;
};

export type PhotoToolsDeps = {
  store: Pick<AliceStore, "insertOutboundMessage" | "markOutboundMessageSent" | "markOutboundMessageFailed">;
  outputRouter: Pick<OutputRouter, "send">;
  time?: CurrentTimeProvider;
  selfieConfigPath?: string;
  selfieMode?: SelfieGenerationMode;
  selfieReferenceDir?: string;
  selfieOutputDir?: string;
  selfieAssetRoot?: string;
  selfieCodexCommand?: string;
  selfieCodexTimeoutMs?: number;
  selfieImageApiKey?: string;
  selfieImageApiBaseURL?: string;
  selfieImageApiRelayKey?: string;
  selfieImageApiRelayBaseURL?: string;
  selfieImageApiModel?: string;
  selfieImageApiSize?: string;
  selfieImageApiQuality?: string;
  selfieImageApiModeration?: string;
  selfieImageApiOutputFormat?: string;
  selfieImageApiOutputCompression?: number;
  selfieImageApiTimeoutMs?: number;
  selfieImageApiRelayModel?: string;
  selfieImageApiRelaySize?: string;
  selfieImageApiRelayQuality?: string;
  selfieImageApiRelayModeration?: string;
  selfieImageApiRelayOutputFormat?: string;
  selfieImageApiRelayOutputCompression?: number;
  selfieImageApiRelayTimeoutMs?: number;
  selfieMaxBytes?: number;
  selfieExecutor?: SelfieExecutor;
  getWorldWandererStreetViewReferenceImage?(): Promise<string | undefined> | string | undefined;
  getSelfieContext?(): SelfieContext;
  getUserName?: () => string;
  getAppearanceDescription?: () => string;
  getDefaultTarget?(): PhotoToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
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
  let failedSelfieMarker: number | undefined;

  return {
    id: "photo",
    listTools() {
      return [selfieTool];
    },
    async execute(call, executionContext) {
      if (call.toolName === "selfie") return selfie(call, executionContext);
      return { callId: call.id, ok: false, error: `Unknown photo tool: ${call.toolName}` };
    }
  };

  async function selfie(call: ToolCall, executionContext?: ToolExecutionContext): Promise<ToolResult> {
    const marker = selfieMarker(executionContext);
    if (marker !== undefined && failedSelfieMarker === marker) {
      return toolError(call, "selfie is blocked in this agent loop run after a previous failure");
    }

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

    const imageApiSettings = selectedImageApiSettings(photoConfig);
    const imageApiOutputFormat = normalizeOutputFormat(imageApiSettings.outputFormat);
    const fullOutputDir = path.resolve(photoConfig.selfieOutputDir);
    const assetRoot = path.resolve(deps.selfieAssetRoot ?? "assets");
    const relativeDir = path.relative(assetRoot, fullOutputDir);
    if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
      return toolError(call, "selfie output directory must be inside assets");
    }

    let tempDir: string | undefined;
    let codexWorkDir: string | undefined;
    let codexResult: SelfieExecutorResult | undefined;
    try {
      fs.mkdirSync(fullOutputDir, { recursive: true });
      tempDir = path.join(fullOutputDir, `.tmp_${time.now().epochMs}_${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(tempDir, { recursive: true });
      codexWorkDir = path.join(fullOutputDir, `.codex_tmp_${time.now().epochMs}_${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(codexWorkDir, { recursive: true });

      let fileName = `selfie_${formatFileDateTime(time.now().iso)}.${extensionForOutputFormat(imageApiOutputFormat)}`;
      let tempFilePath = path.resolve(tempDir, fileName);
      let finalFilePath = path.resolve(fullOutputDir, fileName);
      let assetId = path.join(relativeDir, fileName);

      await sendText(target, "-少女拍照中-", "system");
      const prompt = buildSelfiePrompt(action, context);
      const references = await resolveReferenceImages(context);
      deps.appendLog?.("info", [
        "selfie generation start:",
        `workDir=${tempDir}`,
        `codexWorkDir=${codexWorkDir}`,
        `file=${fileName}`,
        `mode=${photoConfig.selfieMode}`,
        `aspectRatio=${aspectRatio}`,
        `promptLength=${prompt.length}`,
        `images=${references.images.map((image) => path.basename(image)).join(",")}`,
        references.missingOutfitImage ? "missingOutfitImage=true" : "",
        references.worldWandererStreetViewImage ? `worldWandererStreetView=${path.basename(references.worldWandererStreetViewImage)}` : ""
      ].join(" "));
      const executor = deps.selfieExecutor ?? selfieExecutorForMode(photoConfig.selfieMode);
      const executorResult = await executor({
        command: photoConfig.selfieCodexCommand,
        workDir: tempDir,
        codexWorkDir,
        fileName,
        prompt,
        referenceImages: references.images,
        referenceImagePrompt: references.prompt,
        aspectRatio,
        timeoutMs: photoConfig.selfieCodexTimeoutMs,
        apiKey: imageApiSettings.key,
        apiBaseURL: imageApiSettings.baseURL,
        apiEndpoint: imageApiSettings.endpoint,
        apiModel: imageApiSettings.model,
        apiSize: imageApiSettings.size,
        apiQuality: imageApiSettings.quality,
        apiModeration: imageApiSettings.moderation,
        apiOutputFormat: imageApiOutputFormat,
        apiOutputCompression: imageApiSettings.outputCompression,
        apiTimeoutMs: imageApiSettings.timeoutMs,
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
      const normalizedImage = await normalizeGeneratedSelfieJpeg({
        tempFilePath,
        fileName,
        tempDir,
        maxBytes: photoConfig.selfieMaxBytes,
        timeoutMs: imageApiSettings.timeoutMs
      });
      fileName = normalizedImage.fileName;
      tempFilePath = normalizedImage.tempFilePath;
      finalFilePath = path.resolve(fullOutputDir, fileName);
      assetId = path.join(relativeDir, fileName);
      fs.renameSync(tempFilePath, finalFilePath);
      validateGeneratedImage(finalFilePath, fullOutputDir, photoConfig.selfieMaxBytes);
      const finalImageMime = detectImageMime(fs.readFileSync(finalFilePath));
      if (finalImageMime !== "image/jpeg") throw new Error("generated selfie final file is not JPEG");

      const sent = await sendImage(target, assetId);
      deps.appendLog?.("info", `selfie generation sent: assetId=${assetId} messageId=${extractSentMessageId(sent) ?? ""}`);
      return {
        callId: call.id,
        ok: true,
        output: "照片已发送",
        llmFollowupAttachments: executionContext?.llmCapabilities?.supportsImage
          ? [{
            kind: "image",
            path: finalFilePath,
            assetId,
            mime: finalImageMime,
            followupText: "这是上一步工具返回的图像"
          }]
          : undefined
      };
    } catch (error) {
      const reason = [
        error instanceof Error ? error.message : String(error),
        codexResult?.stdout ? `generator stdout: ${excerpt(codexResult.stdout, 4000)}` : "",
        codexResult?.stderr ? `generator stderr: ${excerpt(codexResult.stderr, 4000)}` : "",
        codexResult?.lastMessage ? `generator last message: ${excerpt(codexResult.lastMessage, 4000)}` : "",
        codexResult?.events ? `generator events: ${excerpt(codexResult.events, 4000)}` : ""
      ].filter(Boolean).join("\n");
      deps.appendLog?.("warn", `selfie generation failed: ${reason}${tempDir ? ` files=${listDirForLog(tempDir)}` : ""}`);
      if (marker !== undefined) failedSelfieMarker = marker;
      await sendSelfieFailureNotice(target);
      return toolError(call, reason);
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      if (codexWorkDir) fs.rmSync(codexWorkDir, { recursive: true, force: true });
    }
  }

  function selfieMarker(context?: ToolExecutionContext): number | undefined {
    const llmSessionId = context?.llmSessionId;
    const agentLoopRunSeq = context?.agentLoopRunSeq;
    if (typeof llmSessionId !== "number" || !Number.isInteger(llmSessionId)) return undefined;
    if (typeof agentLoopRunSeq !== "number" || !Number.isInteger(agentLoopRunSeq)) return undefined;
    return llmSessionId * 1000 + agentLoopRunSeq;
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

  async function resolveReferenceImages(context: SelfieContext): Promise<{ images: string[]; prompt: string; missingOutfitImage: boolean; worldWandererStreetViewImage?: string }> {
    const referenceDir = runtimePhotoConfig().selfieReferenceDir;
    const characterImage = requireFile(path.resolve(referenceDir, characterReferenceFileName), "selfie character reference image was not found");
    const outfitImage = optionalFile(resolveOutfitImage(context));
    const worldWandererStreetViewImage = await resolveWorldWandererStreetViewReferenceImage();
    const images = [characterImage];
    if (outfitImage) images.push(outfitImage);
    if (worldWandererStreetViewImage) {
      images.push(worldWandererStreetViewImage);
    } else {
      images.push(requireFile(path.resolve(referenceDir, libraryReferenceFileName), "selfie library reference image was not found"));
    }
    return {
      images,
      prompt: "",
      missingOutfitImage: !outfitImage,
      worldWandererStreetViewImage
    };
  }

  async function resolveWorldWandererStreetViewReferenceImage(): Promise<string | undefined> {
    const referenceImage = await deps.getWorldWandererStreetViewReferenceImage?.();
    if (!referenceImage) return undefined;
    return requireFile(path.resolve(referenceImage), "world wanderer streetview reference image was not found");
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
    const resolved = deps.resolveOutputTarget?.(call);
    if (resolved) return normalizeTarget(resolved);
    if (call.requester?.plugin && call.externalSession?.sessionId) {
      return normalizeTarget({
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.externalSession.sessionId
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
  description: "根据 action 动作描述自拍。 除非<user>特殊要求,确保只描述拍照时的动作。成功后会自动发送。",
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
  const { selfieImageApiKey, selfieImageApiRelayKey, ...publicConfig } = config;
  return {
    ...publicConfig,
    selfieImageApiKeySet: Boolean(selfieImageApiKey),
    selfieImageApiRelayKeySet: Boolean(selfieImageApiRelayKey)
  };
}

function normalizePhotoPluginConfig(parsed: Record<string, unknown>, defaults: Partial<PhotoPluginConfig> = {}): PhotoPluginConfig {
  return {
    enabled: booleanValue(parsed.enabled, defaults.enabled ?? true),
    selfieMode: selfieModeValue(parsed.selfieMode, defaults.selfieMode ?? "api"),
    selfieReferenceDir: stringConfigValue(parsed.selfieReferenceDir, defaults.selfieReferenceDir ?? "assets/selfie/references"),
    selfieOutputDir: stringConfigValue(parsed.selfieOutputDir, defaults.selfieOutputDir ?? "assets/generated/selfies"),
    selfieCodexCommand: stringConfigValue(parsed.selfieCodexCommand, defaults.selfieCodexCommand ?? "codex"),
    selfieCodexTimeoutMs: numberValue(parsed.selfieCodexTimeoutMs, defaults.selfieCodexTimeoutMs ?? 300_000),
    selfieImageApiKey: stringConfigValue(parsed.selfieImageApiKey, defaults.selfieImageApiKey),
    selfieImageApiBaseURL: stringConfigValue(parsed.selfieImageApiBaseURL, defaults.selfieImageApiBaseURL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    selfieImageApiRelayKey: stringConfigValue(parsed.selfieImageApiRelayKey, defaults.selfieImageApiRelayKey),
    selfieImageApiRelayBaseURL: stringConfigValue(parsed.selfieImageApiRelayBaseURL, defaults.selfieImageApiRelayBaseURL ?? defaults.selfieImageApiBaseURL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    selfieImageApiModel: stringConfigValue(parsed.selfieImageApiModel, defaults.selfieImageApiModel ?? "gpt-image-2"),
    selfieImageApiSize: stringConfigValue(parsed.selfieImageApiSize, defaults.selfieImageApiSize ?? "768x1024"),
    selfieImageApiQuality: stringConfigValue(parsed.selfieImageApiQuality, defaults.selfieImageApiQuality ?? "low"),
    selfieImageApiModeration: stringConfigValue(parsed.selfieImageApiModeration, defaults.selfieImageApiModeration ?? "low"),
    selfieImageApiOutputFormat: normalizeOutputFormat(stringConfigValue(parsed.selfieImageApiOutputFormat, defaults.selfieImageApiOutputFormat ?? "jpeg")),
    selfieImageApiOutputCompression: numberValue(parsed.selfieImageApiOutputCompression, defaults.selfieImageApiOutputCompression ?? 45),
    selfieImageApiTimeoutMs: numberValue(parsed.selfieImageApiTimeoutMs, defaults.selfieImageApiTimeoutMs ?? 120_000),
    selfieImageApiRelayModel: stringConfigValue(parsed.selfieImageApiRelayModel, defaults.selfieImageApiRelayModel ?? defaults.selfieImageApiModel ?? "gpt-image-2"),
    selfieImageApiRelaySize: stringConfigValue(parsed.selfieImageApiRelaySize, defaults.selfieImageApiRelaySize ?? defaults.selfieImageApiSize ?? "768x1024"),
    selfieImageApiRelayQuality: stringConfigValue(parsed.selfieImageApiRelayQuality, defaults.selfieImageApiRelayQuality ?? defaults.selfieImageApiQuality ?? "low"),
    selfieImageApiRelayModeration: stringConfigValue(parsed.selfieImageApiRelayModeration, defaults.selfieImageApiRelayModeration ?? defaults.selfieImageApiModeration ?? "low"),
    selfieImageApiRelayOutputFormat: normalizeOutputFormat(stringConfigValue(parsed.selfieImageApiRelayOutputFormat, defaults.selfieImageApiRelayOutputFormat ?? defaults.selfieImageApiOutputFormat ?? "jpeg")),
    selfieImageApiRelayOutputCompression: numberValue(parsed.selfieImageApiRelayOutputCompression, defaults.selfieImageApiRelayOutputCompression ?? defaults.selfieImageApiOutputCompression ?? 45),
    selfieImageApiRelayTimeoutMs: numberValue(parsed.selfieImageApiRelayTimeoutMs, defaults.selfieImageApiRelayTimeoutMs ?? defaults.selfieImageApiTimeoutMs ?? 120_000),
    selfieMaxBytes: numberValue(parsed.selfieMaxBytes, defaults.selfieMaxBytes ?? 10 * 1024 * 1024)
  };
}

function photoConfigDefaultsFromDeps(deps: PhotoToolsDeps): Partial<PhotoPluginConfig> {
  return {
    enabled: true,
    selfieMode: deps.selfieMode ?? "api",
    selfieReferenceDir: deps.selfieReferenceDir,
    selfieOutputDir: deps.selfieOutputDir,
    selfieCodexCommand: deps.selfieCodexCommand,
    selfieCodexTimeoutMs: deps.selfieCodexTimeoutMs,
    selfieImageApiKey: deps.selfieImageApiKey,
    selfieImageApiBaseURL: deps.selfieImageApiBaseURL,
    selfieImageApiRelayKey: deps.selfieImageApiRelayKey,
    selfieImageApiRelayBaseURL: deps.selfieImageApiRelayBaseURL,
    selfieImageApiModel: deps.selfieImageApiModel,
    selfieImageApiSize: deps.selfieImageApiSize,
    selfieImageApiQuality: deps.selfieImageApiQuality,
    selfieImageApiModeration: deps.selfieImageApiModeration,
    selfieImageApiOutputFormat: deps.selfieImageApiOutputFormat,
    selfieImageApiOutputCompression: deps.selfieImageApiOutputCompression,
    selfieImageApiTimeoutMs: deps.selfieImageApiTimeoutMs,
    selfieImageApiRelayModel: deps.selfieImageApiRelayModel,
    selfieImageApiRelaySize: deps.selfieImageApiRelaySize,
    selfieImageApiRelayQuality: deps.selfieImageApiRelayQuality,
    selfieImageApiRelayModeration: deps.selfieImageApiRelayModeration,
    selfieImageApiRelayOutputFormat: deps.selfieImageApiRelayOutputFormat,
    selfieImageApiRelayOutputCompression: deps.selfieImageApiRelayOutputCompression,
    selfieImageApiRelayTimeoutMs: deps.selfieImageApiRelayTimeoutMs,
    selfieMaxBytes: deps.selfieMaxBytes
  };
}

function selfieExecutorForMode(mode: SelfieGenerationMode): SelfieExecutor {
  return mode === "codex" ? runAliceSelfieFastSkill : runImageApiSelfie;
}

function selectedImageApiSettings(config: PhotoPluginConfig): {
  key?: string;
  baseURL: string;
  endpoint: "edits" | "relayEdits" | "generations";
  model: string;
  size: string;
  quality: string;
  moderation: string;
  outputFormat: string;
  outputCompression: number;
  timeoutMs: number;
} {
  if (config.selfieMode === "openaiRelay") {
    return {
      key: config.selfieImageApiRelayKey,
      baseURL: config.selfieImageApiRelayBaseURL,
      endpoint: "relayEdits",
      model: config.selfieImageApiRelayModel,
      size: config.selfieImageApiRelaySize,
      quality: config.selfieImageApiRelayQuality,
      moderation: config.selfieImageApiRelayModeration,
      outputFormat: config.selfieImageApiRelayOutputFormat,
      outputCompression: config.selfieImageApiRelayOutputCompression,
      timeoutMs: config.selfieImageApiRelayTimeoutMs
    };
  }
  return {
    key: config.selfieImageApiKey,
    baseURL: config.selfieImageApiBaseURL,
    endpoint: "edits",
    model: config.selfieImageApiModel,
    size: config.selfieImageApiSize,
    quality: config.selfieImageApiQuality,
    moderation: config.selfieImageApiModeration,
    outputFormat: config.selfieImageApiOutputFormat,
    outputCompression: config.selfieImageApiOutputCompression,
    timeoutMs: config.selfieImageApiTimeoutMs
  };
}

async function runImageApiSelfie(input: SelfieExecutorInput): Promise<SelfieExecutorResult> {
  if (!input.apiKey) throw new Error("selfie Image API key is not configured; set OPENAI_API_KEY or SELFIE_IMAGE_API_KEY");
  const prompt = input.prompt;
  const form = new FormData();
  form.append("model", input.apiModel);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", input.apiSize);
  form.append("quality", input.apiQuality);
  if (input.apiEndpoint === "generations") {
    form.append("response_format", "b64_json");
    for (const image of input.referenceImages) {
      form.append("image", fileBlob(image), path.basename(image));
    }
  } else if (input.apiEndpoint === "relayEdits") {
    for (const image of input.referenceImages) {
      form.append("image", fileBlob(image), path.basename(image));
    }
  } else {
    form.append("moderation", input.apiModeration);
    form.append("output_format", input.apiOutputFormat);
    if (input.apiOutputFormat === "jpeg" || input.apiOutputFormat === "webp") {
      form.append("output_compression", String(input.apiOutputCompression));
    }
    for (const image of input.referenceImages) {
      form.append("image[]", fileBlob(image), path.basename(image));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.apiTimeoutMs);
  const started = Date.now();
  const endpointPath = input.apiEndpoint === "generations" ? "/images/generations" : "/images/edits";
  const requestUrl = `${input.apiBaseURL}${endpointPath}`;
  try {
    const response = input.apiEndpoint === "generations"
      ? await fetch(requestUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${input.apiKey}`
        },
        body: form,
        ...dispatcherInit(input.proxyUrl)
      })
      : await fetch(requestUrl, {
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
      throw new Error(`Image API ${input.apiEndpoint} failed after ${elapsedMs}ms url=${requestUrl}: HTTP ${response.status} ${response.statusText} ${excerpt(body, 4000)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new Error(`Image API ${input.apiEndpoint} returned non-JSON after ${elapsedMs}ms url=${requestUrl}: ${excerpt(body, 4000)}`);
    }
    const imageB64 = extractImageB64(payload);
    if (!imageB64) {
      throw new Error(`Image API ${input.apiEndpoint} returned no image after ${elapsedMs}ms url=${requestUrl}: ${excerpt(JSON.stringify(payload), 4000)}`);
    }
    fs.writeFileSync(path.join(input.workDir, input.fileName), Buffer.from(imageB64, "base64"));
    return {
      stdout: `Image API completed in ${elapsedMs}ms; file=${input.fileName}`,
      stderr: "",
      lastMessage: `Image API completed in ${elapsedMs}ms`
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Image API ${input.apiEndpoint} request timed out after ${input.apiTimeoutMs}ms url=${requestUrl}`);
    }
    if (error instanceof Error && error.message === "fetch failed") {
      throw new Error(`Image API ${input.apiEndpoint} request failed url=${requestUrl}: ${describeErrorWithCause(error)}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runAliceSelfieFastSkill(input: SelfieExecutorInput): Promise<SelfieExecutorResult> {
  const runnerPath = process.env.ALICE_SELFIE_FAST_RUNNER ?? defaultFastSelfieRunner;
  const configPath = path.join(input.workDir, "alice-selfie-fast-input.json");
  const runnerTimeoutMs = Math.max(1_000, input.timeoutMs - 2_000);
  fs.writeFileSync(configPath, JSON.stringify({
    workDir: input.workDir,
    codexWorkDir: input.codexWorkDir,
    fileName: input.fileName,
    prompt: input.prompt,
    referenceImages: input.referenceImages,
    referenceImagePrompt: input.referenceImagePrompt,
    aspectRatio: input.aspectRatio,
    codexCommand: input.command,
    timeoutMs: runnerTimeoutMs
  }));
  const result = await execFile("node", [runnerPath, "--tool-input", configPath], input.timeoutMs, {
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    SELFIE_IMAGE_API_KEY: "",
    SELFIE_IMAGE_API_BASE_URL: "",
    SELFIE_IMAGE_API_MODEL: "",
    SELFIE_IMAGE_API_SIZE: "",
    SELFIE_IMAGE_API_QUALITY: "",
    SELFIE_IMAGE_API_OUTPUT_FORMAT: "",
    SELFIE_IMAGE_API_OUTPUT_COMPRESSION: "",
    SELFIE_IMAGE_API_TIMEOUT_MS: ""
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    lastMessage: excerpt(result.stderr || result.stdout, 1000),
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

async function normalizeGeneratedSelfieJpeg(input: {
  tempFilePath: string;
  fileName: string;
  tempDir: string;
  maxBytes: number;
  timeoutMs: number;
}): Promise<{ tempFilePath: string; fileName: string }> {
  const actualMime = detectImageMime(fs.readFileSync(input.tempFilePath));
  if (!actualMime) return { tempFilePath: input.tempFilePath, fileName: input.fileName };

  const jpegFileName = replaceImageExtension(input.fileName, "jpg");
  if (actualMime === "image/jpeg") {
    if (input.fileName === jpegFileName) return { tempFilePath: input.tempFilePath, fileName: input.fileName };
    const jpegTempFilePath = path.resolve(input.tempDir, jpegFileName);
    fs.renameSync(input.tempFilePath, jpegTempFilePath);
    return { tempFilePath: jpegTempFilePath, fileName: jpegFileName };
  }

  const outputFileName = input.fileName === jpegFileName
    ? `${path.basename(input.fileName, path.extname(input.fileName))}.converted.jpg`
    : jpegFileName;
  const outputFilePath = path.resolve(input.tempDir, outputFileName);
  await convertImageToJpeg(input.tempFilePath, outputFilePath, input.timeoutMs);
  validateGeneratedImage(outputFilePath, input.tempDir, input.maxBytes);
  const convertedMime = detectImageMime(fs.readFileSync(outputFilePath));
  if (convertedMime !== "image/jpeg") throw new Error("generated selfie JPEG conversion did not produce JPEG bytes");
  fs.rmSync(input.tempFilePath, { force: true });
  return { tempFilePath: outputFilePath, fileName: jpegFileName };
}

async function convertImageToJpeg(inputPath: string, outputPath: string, timeoutMs: number): Promise<void> {
  const ffmpegPath = String(require("ffmpeg-static") || "ffmpeg");
  await execFile(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath
  ], timeoutMs);
}

function detectImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  return undefined;
}

function replaceImageExtension(fileName: string, extension: string): string {
  return `${path.basename(fileName, path.extname(fileName))}.${extension}`;
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

function describeErrorWithCause(error: Error): string {
  const details = [error.message];
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    details.push(`cause=${cause.name}: ${cause.message}`);
    const causeRecord = cause as Error & { code?: unknown; errno?: unknown; syscall?: unknown; address?: unknown; port?: unknown };
    for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
      if (causeRecord[key] !== undefined) details.push(`${key}=${String(causeRecord[key])}`);
    }
  } else if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    details.push(`cause=${JSON.stringify(Object.fromEntries(Object.entries(causeRecord).filter(([, value]) => typeof value !== "function")))}`);
  } else if (cause !== undefined) {
    details.push(`cause=${String(cause)}`);
  }
  return details.join(" ");
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
  return value === "codex" ? "codex" : value === "openaiRelay" ? "openaiRelay" : value === "api" ? "api" : fallback;
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

function mimeForOutputFormat(value: string): string {
  if (value === "png") return "image/png";
  if (value === "webp") return "image/webp";
  return "image/jpeg";
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
