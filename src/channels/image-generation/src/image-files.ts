import { execFile } from "./process-exec.js";

const fs = await import("node:fs");
const moduleApi = await import("node:module");
const path = await import("node:path");
const require = moduleApi.createRequire(import.meta.url);

const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const imageGenerationText = {
  generatedPathOutsideOutput: "generated image path is outside output directory",
  generatedExtensionNotAllowed: "generated image extension is not allowed",
  generatedFileNotFound: (fileName: string, files: string) => `generated image file was not found at expected name ${fileName}; workdir files: ${files}`,
  generatedPathNotFile: "generated image path is not a file",
  generatedFileTooLarge: "generated image file is too large",
  jpegConversionFailed: "generated image JPEG conversion did not produce JPEG bytes",
  emptyDirectory: "(empty)",
  unreadableDirectory: "(unreadable)"
};

export function validateGeneratedImage(filePath: string, outputDir: string, maxBytes: number): void {
  const relative = path.relative(outputDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(imageGenerationText.generatedPathOutsideOutput);
  }
  if (!allowedExtensions.has(path.extname(filePath).toLowerCase())) {
    throw new Error(imageGenerationText.generatedExtensionNotAllowed);
  }
  let stat: { isFile(): boolean; size: number };
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(imageGenerationText.generatedFileNotFound(path.basename(filePath), listDirForLog(outputDir)));
  }
  if (!stat.isFile()) throw new Error(imageGenerationText.generatedPathNotFile);
  if (stat.size > maxBytes) throw new Error(imageGenerationText.generatedFileTooLarge);
}

export async function normalizeGeneratedSelfieJpeg(input: {
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
  if (convertedMime !== "image/jpeg") throw new Error(imageGenerationText.jpegConversionFailed);
  fs.rmSync(input.tempFilePath, { force: true });
  return { tempFilePath: outputFilePath, fileName: jpegFileName };
}

export function detectImageMime(bytes: Buffer): string | undefined {
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

export function listDirForLog(dirPath: string): string {
  try {
    const files = fs.readdirSync(dirPath);
    return files.length > 0 ? files.slice(0, 20).join(",") : imageGenerationText.emptyDirectory;
  } catch {
    return imageGenerationText.unreadableDirectory;
  }
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

function replaceImageExtension(fileName: string, extension: string): string {
  return `${path.basename(fileName, path.extname(fileName))}.${extension}`;
}
