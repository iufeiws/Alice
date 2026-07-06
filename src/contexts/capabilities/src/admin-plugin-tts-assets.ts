import { HttpJsonError, readRawBody } from "../../../apps/api/middleware/http-utils.js";
import { convertReferenceAudio, decodeHeaderFileName, maxTtsReferenceUploadBytes, readMossCodecConfig } from "../../../channels/tts/src/admin-assets.js";
import type { TtsPluginConfig, TtsPreset } from "../../../channels/tts/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import type { TtsAdminConfig } from "./admin-plugin-types.js";
import { optionalString } from "../../../shared/admin-input/src/index.js";
import { defaultPluginAssetFileName, maxPluginAssetUploadBytes, maxPluginModelAssetUploadBytes, resolvePluginAssetPathForUpload, safePluginAssetFileName } from "./admin-plugin-utils.js";
import { readTtsConfigForAdmin, safeTtsPresetName, ttsPresetConfigDirectory, writeTtsConfig } from "./admin-plugin-tts-config.js";
import { publicTtsConfig } from "./admin-plugin-tts-public.js";

const fs = await import("node:fs");
const path = await import("node:path");

export async function uploadGenericPluginAsset(
  context: AdminRoutesContext,
  pluginId: string,
  assetKey: string,
  request: any
): Promise<{ config: TtsAdminConfig; assetPath: string } | { error: string; statusCode?: number }> {
  const config = readTtsConfigForAdmin(context);
  if (!config.activePresetName || !config.presets || !config.activePreset) return { error: "tts_active_preset_not_found" };
  const fileName = safePluginAssetFileName(decodeHeaderFileName(optionalString(request.headers?.["x-file-name"]) ?? ""));
  const relativeDir = decodeHeaderFileName(optionalString(request.headers?.["x-relative-dir"]) ?? "");
  const maxBytes = assetKey === "model"
    ? maxPluginModelAssetUploadBytes
    : pluginId === "tts" && assetKey === "reference-audio"
      ? maxTtsReferenceUploadBytes
      : maxPluginAssetUploadBytes;
  const body = await readRawBody(request, { maxBytes });
  if (body.length === 0) return { error: "empty_upload" };

  const presetName = decodeHeaderFileName(optionalString(request.headers?.["x-preset-name"]) ?? "");
  if (pluginId === "tts" && assetKey === "mimo-voiceclone-audio") {
    const result = writeTtsMimoVoiceCloneAudioUpload(context, config, fileName, body);
    if ("error" in result) return result;
    return result;
  }
  const assetPath = pluginId === "tts"
    ? resolveTtsModelAssetPathForUpload(config, assetKey, fileName, presetName, context.pluginConfigs?.tts?.assetRoot)
    : resolvePluginAssetPathForUpload(pluginId, assetKey, fileName, relativeDir);
  if (pluginId === "tts" && assetKey === "reference-audio") {
    const result = await writeTtsPresetReferenceAudioUpload(context, assetPath.fullPath, fileName, body);
    if (result) return result;
  } else {
    fs.mkdirSync(path.dirname(assetPath.fullPath), { recursive: true });
    fs.writeFileSync(assetPath.fullPath, body);
  }

  const targetPresetName = safeTtsPresetName(presetName || config.editPresetName || config.activePresetName, config.activePresetName);
  const targetPreset = config.presets[targetPresetName] ?? config.activePreset;
  const nextPreset = assetKey === "model"
    ? {
      ...targetPreset,
      provider: "genie" as const,
      genie: {
        ...(targetPreset.genie ?? {}),
        modelDir: path.join("assets", "tts", "preset", targetPresetName, "model").split(path.sep).join("/")
      }
    }
    : targetPreset;
  const next: TtsPluginConfig = {
    ...config,
    editPresetName: targetPresetName,
    presets: {
      ...config.presets,
      [targetPresetName]: nextPreset
    },
    activePreset: config.presets[config.activePresetName] ?? config.activePreset
  };
  writeTtsConfig(context, next);
  return { config: publicTtsConfig(next, context.pluginConfigs?.tts?.assetRoot), assetPath: assetPath.assetPath };
}

function writeTtsMimoVoiceCloneAudioUpload(
  context: AdminRoutesContext,
  config: TtsPluginConfig,
  fileName: string,
  body: Buffer
): { config: TtsAdminConfig; assetPath: string } | { error: string; statusCode?: number } {
  const mimeType = mimoVoiceCloneMimeType(fileName);
  if (!mimeType) return { error: "unsupported_mimo_voiceclone_audio_type" };
  if (!config.activePresetName || !config.presets || !config.activePreset) return { error: "tts_active_preset_not_found" };
  const presetName = config.editPresetName || config.activePresetName;
  const currentPreset = config.presets[presetName] ?? config.activePreset;
  const currentMimo = currentPreset.mimo ?? {};
  const nextMode = "voiceclone" as const;
  const nextPreset: TtsPreset = {
    provider: "mimo",
    mimo: {
      ...currentMimo,
      mode: nextMode,
      voiceCloneAudioDataUrl: `data:${mimeType};base64,${body.toString("base64")}`
    }
  };
  const next: TtsPluginConfig = {
    ...config,
    editPresetName: presetName,
    presets: { ...config.presets, [presetName]: nextPreset },
    activePreset: config.activePresetName === presetName ? nextPreset : config.activePreset
  };
  writeTtsConfig(context, next);
  return { config: publicTtsConfig(next, context.pluginConfigs?.tts?.assetRoot), assetPath: `${path.join(ttsPresetConfigDirectory(context), `${presetName}.json`).split(path.sep).join("/")}#voiceCloneAudioDataUrl` };
}

function mimoVoiceCloneMimeType(fileName: string): string | undefined {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  return undefined;
}

function resolveTtsModelAssetPathForUpload(config: TtsPluginConfig, assetKey: string, fileName: string, presetName?: string, assetRoot = "assets"): { fullPath: string; assetPath: string } {
  if (!config.activePresetName) throw new HttpJsonError(400, "tts_active_preset_not_found");
  const selectedPresetName = safeTtsPresetName(presetName || config.editPresetName || config.activePresetName, config.activePresetName);
  const root = path.resolve(assetRoot, "tts", "preset", selectedPresetName);
  const effectiveFileName = fileName || defaultPluginAssetFileName(assetKey);
  const baseRelativeDir = assetKey === "model" ? "model" : "";
  const outputName = assetKey === "reference-text"
    ? "reference.txt"
    : assetKey === "reference-audio"
      ? "reference.wav"
      : effectiveFileName;
  const fullPath = path.resolve(root, baseRelativeDir, outputName);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpJsonError(400, "invalid_asset_path");
  }
  return {
    fullPath,
    assetPath: path.join("assets", "tts", "preset", selectedPresetName, relative).split(path.sep).join("/")
  };
}

async function writeTtsPresetReferenceAudioUpload(context: AdminRoutesContext, outputPath: string, fileName: string, body: Buffer): Promise<{ error: string; statusCode?: number } | undefined> {
  const extension = path.extname(fileName).toLowerCase();
  if (extension && ![".wav", ".mp3", ".m4a", ".ogg", ".opus"].includes(extension)) {
    return { error: "unsupported_reference_audio_type" };
  }
  const tempDir = path.join(path.dirname(outputPath), `.alice-tts-preset-reference-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const inputPath = path.join(tempDir, `source${extension || ".wav"}`);
  const convertedPath = path.join(tempDir, "reference.wav");
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(inputPath, body);
    await convertReferenceAudio(inputPath, convertedPath, ttsReferenceFfmpegCommand(context), ttsReferenceCodecConfig(context));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.renameSync(convertedPath, outputPath);
    return undefined;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function ttsReferenceFfmpegCommand(context: AdminRoutesContext): string {
  return context.config.tts?.mossFfmpegCommand ?? "ffmpeg-static";
}

function ttsReferenceCodecConfig(context: AdminRoutesContext): { sampleRate: number; channels: number } {
  try {
    return readMossCodecConfig(context);
  } catch {
    return { sampleRate: 48_000, channels: 2 };
  }
}
