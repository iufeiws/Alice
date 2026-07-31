import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SelfieExecutorInput } from "../../../../src/capabilities/tools/photo/src/index.js";
import { createAliceStore } from "../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

export { fs, path };

export const fakeJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
export const png1x1Bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

export function createTestStore(name: string) {
  return createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
}

export function providerInput(prompt: string, referenceImages: string[]): SelfieExecutorInput {
  return {
    command: "",
    workDir: "",
    fileName: "image.jpg",
    prompt,
    codexExtraPrompt: "",
    referenceImages,
    referenceImagePrompt: "",
    timeoutMs: 1000,
    apiBaseURL: "https://api.example.test/v1",
    apiEndpoint: "edits",
    apiModel: "image-model",
    apiSize: "768x1024",
    apiQuality: "low",
    apiModeration: "low",
    apiOutputFormat: "jpeg",
    apiOutputCompression: 45,
    apiTimeoutMs: 1000
  };
}

export function selfieContext() {
  return {
    personalityName: "弱气",
    personalityContent: "说话声音很小",
    outfitId: "gothic_lolita_black",
    outfitName: "黑色哥特洛丽塔",
    outfitContent: "黑色薄纱短袖高领上衣"
  };
}

export function writeReferenceFiles(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "selfie-prompt.txt"), [
    "当前时间:",
    "{{time}}",
    "角色动作:",
    "{{pose}}",
    "角色特征:",
    "{{appearance}}",
    "{{dailyShell/persona/content}}",
    "服装特征:",
    "{{outfit/content}}"
  ].join("\n"));
  fs.writeFileSync(path.join(root, "alice-character-reference.jpg"), "alice-image");
  fs.writeFileSync(path.join(root, "magic-library-reference.jpg"), "library-image");
}

export function makeAssetTempDir(name: string): string {
  const dir = path.join(makeTempDir(`${name}-asset-root`), "assets", "generated", `test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function assetRootFromOutputDir(outputDir: string): string {
  return path.resolve(outputDir, "..", "..");
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
