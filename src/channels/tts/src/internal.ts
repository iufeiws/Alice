const fsp = await import("node:fs/promises");
const fs = await import("node:fs");
const path = await import("node:path");

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseJsonObject(parsed);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function optionalNumberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function ttsReferenceTextValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const filePath = resolveAssetScopedPath(value);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    // Treat it as literal reference text below.
  }
  return value;
}

export function requireGenieReferenceText(value: string | undefined, message: string): string {
  const text = ttsReferenceTextValue(value)?.trim();
  if (!text) throw new Error(message);
  return text;
}

export function referenceTextPath(referenceAudio: string): string {
  return referenceAudio.replace(/\.[^./\\]+$/, "") + ".txt";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeBaseURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const hasScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!hasScheme && !parsed.port) parsed.port = "8767";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export function zipDirectoryToBuffer(rootDir: string): Uint8Array {
  const root = path.resolve(rootDir);
  const files = listZipFiles(root);
  if (!files.length) throw new Error(`Genie TTS model directory has no files to upload: ${root}`);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const filePath of files) {
    const relativeName = path.relative(root, filePath).split(path.sep).join("/");
    const name = new TextEncoder().encode(relativeName);
    const data = fs.readFileSync(filePath);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    writeZipUint32(local, 0, 0x04034b50);
    writeZipUint16(local, 4, 20);
    writeZipUint16(local, 6, 0x0800);
    writeZipUint16(local, 8, 0);
    writeZipUint16(local, 10, 0);
    writeZipUint16(local, 12, 0);
    writeZipUint32(local, 14, crc);
    writeZipUint32(local, 18, data.length);
    writeZipUint32(local, 22, data.length);
    writeZipUint16(local, 26, name.length);
    writeZipUint16(local, 28, 0);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    writeZipUint32(central, 0, 0x02014b50);
    writeZipUint16(central, 4, 20);
    writeZipUint16(central, 6, 20);
    writeZipUint16(central, 8, 0x0800);
    writeZipUint16(central, 10, 0);
    writeZipUint16(central, 12, 0);
    writeZipUint16(central, 14, 0);
    writeZipUint32(central, 16, crc);
    writeZipUint32(central, 20, data.length);
    writeZipUint32(central, 24, data.length);
    writeZipUint16(central, 28, name.length);
    writeZipUint16(central, 30, 0);
    writeZipUint16(central, 32, 0);
    writeZipUint16(central, 34, 0);
    writeZipUint16(central, 36, 0);
    writeZipUint32(central, 38, 0);
    writeZipUint32(central, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralDirectory = concatUint8Arrays(centralParts);
  const end = new Uint8Array(22);
  writeZipUint32(end, 0, 0x06054b50);
  writeZipUint16(end, 4, 0);
  writeZipUint16(end, 6, 0);
  writeZipUint16(end, 8, files.length);
  writeZipUint16(end, 10, files.length);
  writeZipUint32(end, 12, centralDirectory.length);
  writeZipUint32(end, 16, offset);
  writeZipUint16(end, 20, 0);
  return concatUint8Arrays([...localParts, centralDirectory, end]);
}

function listZipFiles(root: string): string[] {
  const result: string[] = [];
  for (const name of fs.readdirSync(root)) {
    const fullPath = path.join(root, name);
    const stats = fs.statSync(fullPath) as { isDirectory?(): boolean; isFile(): boolean };
    if (stats.isDirectory?.()) {
      result.push(...listZipFiles(fullPath));
    } else if (stats.isFile()) {
      result.push(fullPath);
    }
  }
  return result.sort();
}

function writeZipUint16(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(offset, value, true);
}

function writeZipUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value >>> 0, true);
}

const crc32Table = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc = crc32Table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function requireAssetPath(assetId: string, error: string, assetRootInput = "assets"): string {
  const assetRoot = path.resolve(assetRootInput);
  const filePath = resolveAssetScopedPath(assetId, assetRoot);
  const relative = path.relative(assetRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TTS asset path is outside assets directory");
  if (!fs.existsSync(filePath)) throw new Error(error);
  return filePath;
}

export function requireAssetDirectory(assetId: string, error: string, assetRootInput = "assets"): string {
  const dirPath = requireAssetPath(assetId, error, assetRootInput);
  if (fs.statSync(dirPath).isFile()) throw new Error(error);
  return dirPath;
}

export function resolveAssetOutputDir(assetDir: string, assetRootInput = "assets"): { fullPath: string; relativePath: string } {
  const assetRoot = path.resolve(assetRootInput);
  const fullPath = resolveAssetScopedPath(assetDir, assetRoot);
  const relativePath = path.relative(assetRoot, fullPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("TTS output directory must be inside assets");
  }
  return { fullPath, relativePath };
}

export function resolveAssetScopedPath(assetPath: string, assetRoot = path.resolve("assets")): string {
  if (path.isAbsolute(assetPath)) return assetPath;
  const normalized = path.normalize(assetPath);
  if (normalized === "assets" || normalized.startsWith(`assets${path.sep}`)) {
    return path.resolve(normalized);
  }
  return path.resolve(assetRoot, normalized);
}

export function validateGeneratedVoice(filePath: string, outputDir: string): void {
  const relative = path.relative(outputDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TTS output file is outside output directory");
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("TTS output is not a file");
  if (stat.size <= 0) throw new Error("TTS output file is empty");
}

export function uniqueVoiceBaseName(outputDir: string, iso: string): string {
  const baseName = formatFileDateTime(iso);
  let candidate = baseName;
  let suffix = 2;
  while (fs.existsSync(path.join(outputDir, `${candidate}.wav`)) || fs.existsSync(path.join(outputDir, `${candidate}.opus`))) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function removeGeneratedVoice(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

function formatFileDateTime(value: string): string {
  return value.replace(/[-:]/g, "").replace("T", "_").replace(".", "_");
}
