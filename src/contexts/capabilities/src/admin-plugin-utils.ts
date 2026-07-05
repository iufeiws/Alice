import { HttpJsonError } from "../../../apps/api/middleware/http-utils.js";
import { requiredString } from "../../../shared/admin-input/src/index.js";

const path = await import("node:path");

export const maxPluginAssetUploadBytes = 100 * 1024 * 1024;
export const maxPluginModelAssetUploadBytes = 512 * 1024 * 1024;

export function optionalNumberFromUnknown(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : Number.NaN;
}

export function secretStringFromUnknown(value: unknown, fallback: string | undefined): string | undefined {
  const text = requiredString(value).trim();
  return text ? text : fallback;
}

export function resolvePluginAssetPathForUpload(pluginId: string, assetKey: string, fileName: string, relativeDir: string, assetRoot = "assets"): { fullPath: string; assetPath: string } {
  const root = path.resolve(assetRoot, "plugin", pluginId);
  const normalizedRelativeDir = sanitizePluginAssetRelativePath(relativeDir);
  const effectiveFileName = fileName || defaultPluginAssetFileName(assetKey);
  const baseRelativeDir = assetKey === "model" || assetKey === "test-audio" ? assetKey : normalizedRelativeDir;
  const fullPath = path.resolve(root, baseRelativeDir, effectiveFileName);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpJsonError(400, "invalid_asset_path");
  }
  return {
    fullPath,
    assetPath: path.join("assets", "plugin", pluginId, relative).split(path.sep).join("/")
  };
}

export function defaultPluginAssetFileName(assetKey: string): string {
  if (assetKey === "reference-text") return "reference.txt";
  if (assetKey === "reference-audio") return "reference";
  return "asset";
}

export function safePluginAssetFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^\w.\- ]+/g, "_").trim();
  return base || "";
}

export function sanitizePluginAssetRelativePath(value: string): string {
  if (!value) return "";
  const normalized = path.normalize(value).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized === "." ? "" : normalized;
}

export function isPluginAssetPath(pluginId: string, value: string, assetRoot = "assets"): boolean {
  const root = path.resolve(assetRoot, "plugin", pluginId);
  const fullPath = resolvePluginAssetPath(pluginId, value, assetRoot);
  const relative = path.relative(root, fullPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolvePluginAssetPath(pluginId: string, value: string, assetRoot = "assets"): string {
  const normalized = path.normalize(value);
  const prefix = path.join("assets", "plugin", pluginId);
  if (normalized === prefix || normalized.startsWith(prefix + path.sep)) {
    return path.resolve(assetRoot, path.relative("assets", normalized));
  }
  return path.resolve(value);
}

export function invalidNumber(value: unknown, min?: number, max?: number): boolean {
  return typeof value !== "number" || !Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max);
}
