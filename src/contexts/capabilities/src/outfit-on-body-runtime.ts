import type { ShellOption } from "../../agent-profile/src/domain/shell.js";
import { shouldAttemptOnBodyGeneration } from "../../agent-profile/src/domain/outfit.js";
import type { PromptContextRuntime } from "../../prompt-context/src/index.js";
import { defaultPhotoPluginConfigPath, detectImageMime, normalizeGeneratedSelfieJpeg, readPhotoPluginConfig, runPhotoGateway, validateGeneratedImage } from "../../../channels/image-generation/src/index.js";
import { optionalString, requiredString } from "../../../shared/admin-input/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type PhotoOnBodyGenerationResult =
  | { ok: true; imageUrl: string; mime: string; onBodyGenerationAttempted: true }
  | { ok: false; error: string; statusCode: number; onBodyGenerationAttempted?: true };

export function createOutfitOnBodyGenerationAttempt(input: {
  config: any;
  dailyShellStore: any;
  time: any;
  promptProfileStore: any;
  coreProfileStore: any;
  promptContextRuntime: PromptContextRuntime;
  photoConfigPath?: string;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  return async function attemptOutfitOnBodyGeneration(outfit: ShellOption): Promise<void> {
    if (!shouldAttemptOnBodyGeneration(outfit) || !outfit.imageUrl) return;
    const photoConfigPath = input.photoConfigPath ?? defaultPhotoPluginConfigPath;
    let photoConfig;
    try {
      photoConfig = readPhotoPluginConfig(photoConfigPath, input.config.photo);
    } catch (error) {
      input.appendLog("warn", `shell on-body auto generation skipped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!photoConfig.autoGenerateOutfitOnBody) return;
    const result = await generatePhotoOnBodyImage({
      config: input.config,
      pluginConfigs: { photo: { configPath: photoConfigPath } },
      dailyShellStore: input.dailyShellStore,
      time: input.time,
      promptProfileStore: input.promptProfileStore,
      coreProfileStore: input.coreProfileStore,
      getPromptRenderer: () => input.promptContextRuntime,
      appendLog: input.appendLog
    } as any, {
      outfitId: outfit.id,
      outfitName: outfit.name,
      outfitContent: outfit.content,
      outfitGroup: outfit.group,
      outfitImageUrl: outfit.imageUrl,
      onBodyImageUrl: outfit.onBodyImageUrl,
      outfitImageGenerated: outfit.outfitImageGenerated,
      onBodyGenerationAttempted: outfit.onBodyGenerationAttempted
    });
    if (!result.ok) input.appendLog(result.onBodyGenerationAttempted ? "info" : "warn", `shell on-body generation failed: ${result.error}`);
  };
}

export async function generatePhotoOnBodyImage(context: any, body: Record<string, unknown>): Promise<PhotoOnBodyGenerationResult> {
  const config = readPhotoPluginConfig(photoConfigPath(context), photoConfigDefaults(context));
  const promptTemplate = config.onBodyPrompt;
  if (!promptTemplate.trim()) {
    return { ok: false, statusCode: 400, error: "missing_on_body_prompt" };
  }
  const fullBodyReference = photoImagePath(config.onBodyReferenceImage);
  if (!fullBodyReference) {
    return { ok: false, statusCode: 400, error: "missing_on_body_reference_image" };
  }
  const outfitImageUrl = requiredString(body.outfitImageUrl);
  const outfitId = safeFilePart(requiredString(body.outfitId));
  if (!outfitId) {
    return { ok: false, statusCode: 400, error: "missing_outfit_id" };
  }
  const outfitReference = photoImagePath(outfitImageUrl);
  if (!outfitReference) {
    return { ok: false, statusCode: 400, error: "missing_outfit_reference_image" };
  }
  const outfit = resolvePhotoOnBodyOutfit(context, body, outfitId, outfitImageUrl);
  if (!outfit) {
    return { ok: false, statusCode: 400, error: "missing_outfit_content" };
  }

  const outputDir = path.dirname(outfitReference);
  const finalFileName = `${outfitId}.On_Body_Ref.jpg`;
  const finalImageUrl = path.join(path.dirname(outfitImageUrl), finalFileName);
  const tempDir = path.join(outputDir, `.tmp_on_body_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    savePhotoOnBodyAttempt(context, outfit);
    const prompt = renderPhotoOnBodyPrompt(context, promptTemplate);
    const generated = await runPhotoGateway({
      config,
      workDir: tempDir,
      fileBaseName: `${outfitId}.On_Body_Ref`,
      prompt,
      referenceImages: [fullBodyReference, outfitReference],
      proxyUrl: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    });
    let tempFilePath = path.resolve(tempDir, generated.fileName);

    validateGeneratedImage(tempFilePath, tempDir, config.selfieMaxBytes);
    const normalizedImage = await normalizeGeneratedSelfieJpeg({
      tempFilePath,
      fileName: generated.fileName,
      tempDir,
      maxBytes: config.selfieMaxBytes,
      timeoutMs: generated.timeoutMs
    });
    tempFilePath = normalizedImage.tempFilePath;
    const finalFilePath = path.resolve(outputDir, finalFileName);
    fs.renameSync(tempFilePath, finalFilePath);
    validateGeneratedImage(finalFilePath, outputDir, config.selfieMaxBytes);
    const mime = detectImageMime(fs.readFileSync(finalFilePath)) ?? "image/jpeg";
    savePhotoOnBodyAttempt(context, outfit, finalImageUrl);
    context.appendLog("info", `photo on-body generated: ${finalImageUrl}`);
    return {
      ok: true,
      imageUrl: finalImageUrl,
      mime,
      onBodyGenerationAttempted: true
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempted = isPhotoOnBodyModerationFailure(message) || hasPhotoOnBodyImage(context, outfit);
    if (!attempted) clearPhotoOnBodyAttempt(context, outfit);
    context.appendLog("warn", `photo on-body generation failed: ${message}`);
    return {
      ok: false,
      statusCode: photoOnBodyFailureStatus(message),
      error: message,
      ...(attempted ? { onBodyGenerationAttempted: true as const } : {})
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function photoConfigPath(context: any): string {
  return context.pluginConfigs?.photo?.configPath ?? defaultPhotoPluginConfigPath;
}

function photoConfigDefaults(context: any) {
  return context.config?.photo ?? {};
}

function photoImagePath(value: string): string | undefined {
  const fullPath = path.resolve(value);
  return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() ? fullPath : undefined;
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function resolvePhotoOnBodyOutfit(context: any, body: Record<string, unknown>, outfitId: string, outfitImageUrl: string): ShellOption | undefined {
  const shellConfig = context.dailyShellStore.getConfig(context.time.now().date, context.time.timeZone);
  const stored = Array.isArray(shellConfig.outfits)
    ? shellConfig.outfits.find((outfit: ShellOption) => outfit.id === outfitId)
    : undefined;
  const name = stored?.name ?? optionalString(body.outfitName);
  const content = stored?.content ?? optionalString(body.outfitContent);
  if (!name || !content) return undefined;
  return {
    id: outfitId,
    name,
    content,
    group: stored?.group ?? optionalString(body.outfitGroup),
    imageUrl: outfitImageUrl,
    onBodyImageUrl: stored?.onBodyImageUrl ?? optionalString(body.onBodyImageUrl),
    outfitImageGenerated: stored?.outfitImageGenerated ?? body.outfitImageGenerated === true,
    onBodyGenerationAttempted: stored?.onBodyGenerationAttempted ?? body.onBodyGenerationAttempted === true
  };
}

function renderPhotoOnBodyPrompt(context: any, template: string): string {
  return context.getPromptRenderer().renderText(template);
}

function savePhotoOnBodyAttempt(context: any, outfit: ShellOption, imageUrl?: string): void {
  const current = context.dailyShellStore.getConfig(context.time.now().date, context.time.timeZone).outfits.find((entry: { id?: string }) => entry.id === outfit.id);
  const onBodyImageUrl = imageUrl ?? current?.onBodyImageUrl ?? outfit.onBodyImageUrl;
  context.dailyShellStore.saveOption("outfits", {
    ...(current ?? outfit),
    ...(onBodyImageUrl ? { onBodyImageUrl } : {}),
    onBodyGenerationAttempted: true
  }, outfit.id);
}

function clearPhotoOnBodyAttempt(context: any, outfit: ShellOption): void {
  if (hasPhotoOnBodyImage(context, outfit)) return;
  const current = context.dailyShellStore.getConfig(context.time.now().date, context.time.timeZone).outfits.find((entry: { id?: string }) => entry.id === outfit.id);
  context.dailyShellStore.saveOption("outfits", {
    ...(current ?? outfit),
    onBodyGenerationAttempted: undefined
  }, outfit.id);
}

function hasPhotoOnBodyImage(context: any, outfit: Pick<ShellOption, "id" | "onBodyImageUrl">): boolean {
  const current = context.dailyShellStore.getConfig(context.time.now().date, context.time.timeZone).outfits.find((entry: { id?: string }) => entry.id === outfit.id);
  return Boolean(current?.onBodyImageUrl || outfit.onBodyImageUrl);
}

function photoOnBodyFailureStatus(message: string): number {
  const status = imageApiHttpStatus(message);
  return status && [502, 503, 504].includes(status) ? status : 500;
}

function imageApiHttpStatus(message: string): number | undefined {
  const match = /\bHTTP\s+(\d{3})\b/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function isPhotoOnBodyModerationFailure(message: string): boolean {
  return /moderation|safety|content[_ -]?policy|policy violation|content[_ -]?filter|blocked|rejected/i.test(message);
}
