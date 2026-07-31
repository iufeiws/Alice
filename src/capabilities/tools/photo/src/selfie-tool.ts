import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ToolCall, ToolExecutionContext, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import type { PromptContextRuntime } from "../../../../contexts/prompt-context/src/index.js";
import { normalizePhotoPluginConfig, readPhotoPluginConfig, type PhotoPluginConfig } from "./config.js";
import { detectImageMime, listDirForLog, normalizeGeneratedSelfieJpeg, runPhotoGateway, validateGeneratedImage, type ImageGenerationProvider, type ImageGenerationProviderInput, type ImageGenerationProviderResult } from "../../../../channels/image-generation/src/index.js";
import { extractSentMessageId, sendImage, sendSelfieFailureNotice, sendText, type PhotoSendDeps } from "./send-output.js";
import { photoToolText, selfieTool } from "../profile.js";

export { selfieTool };

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
  appearanceDescription?: string;
  personalityName: string;
  personalityContent: string;
  outfitId: string;
  outfitName: string;
  outfitContent: string;
  outfitImageUrl?: string;
  onBodyImageUrl?: string;
  outfitImageGenerated?: boolean;
  onBodyGenerationAttempted?: boolean;
};

export type SelfieExecutorInput = ImageGenerationProviderInput;
export type SelfieExecutorResult = ImageGenerationProviderResult;
export type SelfieExecutor = ImageGenerationProvider;

export type PhotoToolsDeps = Partial<PhotoPluginConfig> & PhotoSendDeps & {
  time?: CurrentTimeProvider;
  selfieConfigPath?: string;
  selfieAssetRoot?: string;
  selfieExecutor?: SelfieExecutor;
  getWorldWandererStreetViewReferenceImage?(): Promise<string | undefined> | string | undefined;
  getSelfieContext?(): SelfieContext;
  promptContextRuntime: PromptContextRuntime;
  getUserName?: () => string;
  getAppearanceDescription?: () => string;
  getDefaultTarget?(): PhotoToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
  mountGeneratedSelfieInSandbox?(input: { hostPath: string; containerPath: string }): void;
};

const selfiePromptFileName = "selfie-prompt.txt";
const characterReferenceFileName = "alice-character-reference.jpg";
const libraryReferenceFileName = "magic-library-reference.jpg";

export function createSelfieExecutor(deps: PhotoToolsDeps, time: CurrentTimeProvider, proxyUrl?: string): (call: ToolCall, executionContext?: ToolExecutionContext) => Promise<ToolResult> {
  let failedSelfieMarker: number | undefined;
  return selfie;

  async function selfie(call: ToolCall, executionContext?: ToolExecutionContext): Promise<ToolResult> {
    const marker = selfieMarker(executionContext);
    if (marker !== undefined && failedSelfieMarker === marker) {
      return toolError(call, photoToolText.previousFailureBlocked);
    }

    const photoConfig = runtimePhotoConfig();
    if (!photoConfig.enabled) return toolError(call, photoToolText.selfieDisabled);

    const target = resolveTarget(call);
    if (!target) return toolError(call, photoToolText.noCurrentSession);

    const pose = stringValue(call.input.pose).trim();
    if (!pose) return toolError(call, photoToolText.poseRequired);

    const context = deps.getSelfieContext?.();
    if (!context) return toolError(call, photoToolText.contextUnavailable);

    const fullOutputDir = path.resolve(photoConfig.selfieOutputDir);
    const assetRoot = path.resolve(deps.selfieAssetRoot ?? "assets");
    const relativeDir = path.relative(assetRoot, fullOutputDir);
    if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
      return toolError(call, photoToolText.outputDirOutsideAssets);
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

      const fileBaseName = `selfie_${formatFileDateTime(time.now().iso)}`;
      let fileName = "";
      let tempFilePath = "";
      let finalFilePath = "";
      let assetId = "";

      await sendText(deps, time, target, photoToolText.takingNotice, "system");
      const references = await resolveReferenceImages(context);
      const prompt = buildSelfiePrompt(pose);
      deps.appendLog?.("info", [
        "selfie generation start:",
        `workDir=${tempDir}`,
        `codexWorkDir=${codexWorkDir}`,
        `file=${fileBaseName}`,
        `mode=${photoConfig.selfieMode}`,
        `promptLength=${prompt.length}`,
        `images=${references.images.map((image) => path.basename(image)).join(",")}`,
        references.usesOnBodyReference ? "usesOnBodyReference=true" : "",
        references.missingOutfitImage ? "missingOutfitImage=true" : "",
        references.worldWandererStreetViewImage ? `worldWandererStreetView=${path.basename(references.worldWandererStreetViewImage)}` : ""
      ].join(" "));
      const executorResult = await runPhotoGateway({
        config: photoConfig,
        workDir: tempDir,
        codexWorkDir,
        fileBaseName,
        prompt,
        referenceImages: references.images,
        referenceImagePrompt: references.prompt,
        proxyUrl,
        executor: deps.selfieExecutor
      });
      fileName = executorResult.fileName;
      tempFilePath = path.resolve(tempDir, fileName);
      finalFilePath = path.resolve(fullOutputDir, fileName);
      assetId = path.join(relativeDir, fileName);
      codexResult = executorResult;
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
        timeoutMs: executorResult.timeoutMs
      });
      fileName = normalizedImage.fileName;
      tempFilePath = normalizedImage.tempFilePath;
      finalFilePath = path.resolve(fullOutputDir, fileName);
      assetId = path.join(relativeDir, fileName);
      fs.renameSync(tempFilePath, finalFilePath);
      validateGeneratedImage(finalFilePath, fullOutputDir, photoConfig.selfieMaxBytes);
      const finalImageMime = detectImageMime(fs.readFileSync(finalFilePath));
      if (finalImageMime !== "image/jpeg") throw new Error(photoToolText.finalFileNotJpeg);

      const sent = await sendImage(deps, time, target, assetId);
      deps.mountGeneratedSelfieInSandbox?.({
        hostPath: finalFilePath,
        containerPath: path.posix.join("/assets/generated/selfies", path.basename(fileName))
      });
      deps.appendLog?.("info", `selfie generation sent: assetId=${assetId} messageId=${extractSentMessageId(sent) ?? ""}`);
      return {
        callId: call.id,
        ok: true,
        output: photoToolText.sent(path.basename(fileName)),
        llmFollowupAttachments: executionContext?.llmCapabilities?.supportsImage
          ? [{
            kind: "image",
            path: finalFilePath,
            assetId,
            mime: finalImageMime,
            followupText: photoToolText.followupImageText
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

  function buildSelfiePrompt(pose: string): string {
    const photoConfig = runtimePhotoConfig();
    const referenceDir = photoConfig.selfieReferenceDir;
    const templatePath = path.resolve(referenceDir, selfiePromptFileName);
    if (!fs.existsSync(templatePath)) throw new Error(photoToolText.promptTemplateNotFound);
    const runtime = deps.promptContextRuntime.withVariables({ pose });
    const prompt = runtime.renderText(fs.readFileSync(templatePath, "utf8"));
    return photoConfig.selfie2DinRealEnabled && photoConfig.selfie2DinRealPrompt
      ? `${prompt}\n\n${runtime.renderText(photoConfig.selfie2DinRealPrompt)}`
      : prompt;
  }

  async function resolveReferenceImages(context: SelfieContext): Promise<{ images: string[]; prompt: string; missingOutfitImage: boolean; usesOnBodyReference: boolean; worldWandererStreetViewImage?: string }> {
    const photoConfig = runtimePhotoConfig();
    const referenceDir = photoConfig.selfieReferenceDir;
    const onBodyReference = resolveOnBodyReference(context);
    const worldWandererStreetViewImage = await resolveWorldWandererStreetViewReferenceImage();
    const characterImage = photoConfig.selfie2DinRealEnabled
      ? requireFile(path.resolve(photoConfig.selfie2DinRealReferenceImage), "2DinReal reference image not found")
      : requireFile(path.resolve(referenceDir, characterReferenceFileName), photoToolText.characterReferenceNotFound);
    const images = [characterImage];
    const outfitImage = onBodyReference ? undefined : optionalFile(resolveOutfitImage(context));
    if (onBodyReference) images.push(onBodyReference);
    if (!onBodyReference && outfitImage) images.push(outfitImage);
    if (worldWandererStreetViewImage) {
      images.push(worldWandererStreetViewImage);
    } else {
      images.push(requireFile(path.resolve(referenceDir, libraryReferenceFileName), photoToolText.libraryReferenceNotFound));
    }
    return {
      images,
      prompt: "",
      missingOutfitImage: !onBodyReference && !outfitImage,
      usesOnBodyReference: Boolean(onBodyReference),
      worldWandererStreetViewImage
    };
  }

  function resolveOnBodyReference(context: SelfieContext): string | undefined {
    if (context.outfitImageGenerated === true) return requireFile(resolveOutfitImage(context), photoToolText.onBodyReferenceNotFound);
    const imageUrl = context.onBodyImageUrl?.trim();
    return imageUrl ? requireFile(path.resolve(imageUrl), photoToolText.onBodyReferenceNotFound) : undefined;
  }

  async function resolveWorldWandererStreetViewReferenceImage(): Promise<string | undefined> {
    const referenceImage = await deps.getWorldWandererStreetViewReferenceImage?.();
    if (!referenceImage) return undefined;
    return requireFile(path.resolve(referenceImage), photoToolText.streetviewReferenceNotFound);
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
