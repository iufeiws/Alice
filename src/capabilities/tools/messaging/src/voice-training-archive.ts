import fsp from "node:fs/promises";
import path from "node:path";
import type { VoiceSynthesisResult } from "../../../../channels/tts/src/index.js";
import type { MessagingToolTarget } from "./types.js";

export async function removeGeneratedVoice(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export async function copyVoiceMessageTrainingAsset(input: {
  outputDir: string;
  text: string;
  target: MessagingToolTarget;
  synthesized: VoiceSynthesisResult;
  status: "sent" | "failed";
  archivedAt: string;
}): Promise<string> {
  const outputDir = path.resolve(input.outputDir);
  await fsp.mkdir(outputDir, { recursive: true });
  const extension = path.extname(input.synthesized.filePath) || ".audio";
  const baseName = [
    safeTrainingPathPart(input.archivedAt.replace(/[:.]/g, "-")),
    safeTrainingPathPart(input.target.plugin),
    safeTrainingPathPart(input.target.sessionId),
    safeTrainingPathPart(path.basename(input.synthesized.assetId, path.extname(input.synthesized.assetId)))
  ].join("-");
  const audioPath = path.join(outputDir, `${baseName}${extension}`);
  await fsp.copyFile(input.synthesized.filePath, audioPath);
  await fsp.writeFile(`${audioPath}.json`, `${JSON.stringify({
    text: input.text,
    status: input.status,
    plugin: input.target.plugin,
    accountId: input.target.accountId,
    channelId: input.target.channelId,
    userId: input.target.userId,
    sessionId: input.target.sessionId,
    assetId: input.synthesized.assetId,
    sourceFilePath: input.synthesized.filePath,
    audioFilePath: audioPath,
    archivedAt: input.archivedAt
  }, null, 2)}\n`, "utf8");
  return audioPath;
}

function safeTrainingPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "unknown";
}
