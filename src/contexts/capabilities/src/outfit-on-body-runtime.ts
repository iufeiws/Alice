import type { ShellOption } from "../../agent-profile/src/domain/shell.js";
import { shouldAttemptOnBodyGeneration } from "../../agent-profile/src/domain/outfit.js";
import { defaultPhotoPluginConfigPath, readPhotoPluginConfig } from "../../../capabilities/tools/photo/src/index.js";
import { generatePhotoOnBodyImage } from "./admin-plugin-runtime.js";

export function createOutfitOnBodyGenerationAttempt(input: {
  config: any;
  dailyShellStore: any;
  time: any;
  promptProfileStore: any;
  coreProfileStore: any;
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
