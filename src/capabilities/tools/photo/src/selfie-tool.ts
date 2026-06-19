import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import { buildLLMTextVariables, renderLLMText } from "../../../../contexts/agent-profile/src/ports/prompt-rendering.js";
import { extensionForOutputFormat, normalizePhotoPluginConfig, readPhotoPluginConfig, selectedImageApiSettings, type PhotoPluginConfig, type SelfieGenerationMode } from "./config.js";
import { runAliceSelfieFastSkill } from "./codex-selfie.js";
import { detectImageMime, listDirForLog, normalizeGeneratedSelfieJpeg, validateGeneratedImage } from "./image-files.js";
import { runOpenAIAPISelfie } from "./openai-api-selfie.js";
import { extractSentMessageId, sendImage, sendSelfieFailureNotice, sendText, type PhotoSendDeps } from "./send-output.js";

const fs = await import("node:fs");
const path = await import("node:path");

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

export type SelfieAspectRatio = "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

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
  apiEndpoint: "edits" | "relayEdits";
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

export type PhotoToolsDeps = Partial<PhotoPluginConfig> & PhotoSendDeps & {
  time?: CurrentTimeProvider;
  selfieConfigPath?: string;
  selfieAssetRoot?: string;
  selfieExecutor?: SelfieExecutor;
  getWorldWandererStreetViewReferenceImage?(): Promise<string | undefined> | string | undefined;
  getSelfieContext?(): SelfieContext;
  getUserName?: () => string;
  getAppearanceDescription?: () => string;
  getDefaultTarget?(): PhotoToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
};

const allowedAspectRatios = new Set<SelfieAspectRatio>(["1:1", "4:3", "3:4", "16:9", "9:16"]);
const selfiePromptFileName = "selfie-prompt.txt";
const characterReferenceFileName = "alice-character-reference.png";
const libraryReferenceFileName = "magic-library-reference.png";

export function createSelfieExecutor(deps: PhotoToolsDeps, time: CurrentTimeProvider, proxyUrl?: string): (call: ToolCall, executionContext?: ToolExecutionContext) => Promise<ToolResult> {
  let failedSelfieMarker: number | undefined;
  return selfie;

  async function selfie(call: ToolCall, executionContext?: ToolExecutionContext): Promise<ToolResult> {
    const marker = selfieMarker(executionContext);
    if (marker !== undefined && failedSelfieMarker === marker) {
      return toolError(call, "selfie is blocked in this agent loop run after a previous failure");
    }

    const photoConfig = runtimePhotoConfig();
    if (!photoConfig.enabled) return toolError(call, "photo selfie is disabled");

    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");

    const action = stringValue(call.input.action).trim();
    if (!action) return toolError(call, "action is required");

    const aspectRatio = normalizeAspectRatio(call.input.aspectRatio);
    if (!aspectRatio) return toolError(call, "unsupported aspectRatio");

    const context = deps.getSelfieContext?.();
    if (!context) return toolError(call, "selfie context is not available");

    const imageApiSettings = selectedImageApiSettings(photoConfig);
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

      let fileName = `selfie_${formatFileDateTime(time.now().iso)}.${extensionForOutputFormat(imageApiSettings.outputFormat)}`;
      let tempFilePath = path.resolve(tempDir, fileName);
      let finalFilePath = path.resolve(fullOutputDir, fileName);
      let assetId = path.join(relativeDir, fileName);

      await sendText(deps, time, target, "-少女拍照中-", "system");
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
        apiOutputFormat: imageApiSettings.outputFormat,
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

      const sent = await sendImage(deps, time, target, assetId);
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
      await sendSelfieFailureNotice(deps, time, target);
      return toolError(call, reason);
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      if (codexWorkDir) fs.rmSync(codexWorkDir, { recursive: true, force: true });
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

  function resolveTarget(call: ToolCall): PhotoToolTarget | undefined {
    const resolved = deps.resolveOutputTarget?.(call);
    return resolved ?? deps.getDefaultTarget?.();
  }

  function runtimePhotoConfig(): PhotoPluginConfig {
    return deps.selfieConfigPath
      ? readPhotoPluginConfig(deps.selfieConfigPath, deps)
      : normalizePhotoPluginConfig({}, deps);
  }
}

export const selfieTool: ToolDefinition = {
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

function selfieExecutorForMode(mode: SelfieGenerationMode): SelfieExecutor {
  return mode === "codex" ? runAliceSelfieFastSkill : runOpenAIAPISelfie;
}

function selfieMarker(context?: ToolExecutionContext): number | undefined {
  const llmSessionId = context?.llmSessionId;
  const agentLoopRunSeq = context?.agentLoopRunSeq;
  if (typeof llmSessionId !== "number" || !Number.isInteger(llmSessionId)) return undefined;
  if (typeof agentLoopRunSeq !== "number" || !Number.isInteger(agentLoopRunSeq)) return undefined;
  return llmSessionId * 1000 + agentLoopRunSeq;
}

function requireFile(filePath: string, error: string): string {
  if (!fs.existsSync(filePath)) throw new Error(error);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(error);
  return filePath;
}

function optionalFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.statSync(filePath).isFile() ? filePath : undefined;
}

function resolveOutfitImage(context: SelfieContext): string {
  const imageUrl = context.outfitImageUrl?.trim();
  if (imageUrl) return path.resolve(imageUrl);
  return path.resolve("memory-files", "shell", "outfits", `${safeFilePart(context.outfitId)}.jpg`);
}

function excerpt(value: string | undefined, maxLength = 500): string {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function normalizeAspectRatio(value: unknown): SelfieAspectRatio | undefined {
  const text = stringValue(value) || "3:4";
  return allowedAspectRatios.has(text as SelfieAspectRatio) ? text as SelfieAspectRatio : undefined;
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
