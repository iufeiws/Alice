const fs = await import("node:fs");
const path = await import("node:path");

export class AssetValidationError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "AssetValidationError";
  }
}

export type AssetValidationOptions = {
  root?: string;
  allowedExtensions: string[];
  maxBytes: number;
};

export function resolveAdminAssetPath(assetId: string, options: AssetValidationOptions): string {
  const root = path.resolve(options.root ?? "assets");
  const trimmed = assetId.trim();
  if (!trimmed) {
    throw new AssetValidationError("missing_asset");
  }
  if (trimmed.startsWith("file://") || path.isAbsolute(trimmed)) {
    throw new AssetValidationError("asset_must_be_relative");
  }

  const normalized = path.normalize(trimmed);
  const fullPath = path.resolve(root, normalized);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AssetValidationError("asset_outside_assets");
  }

  const extension = path.extname(fullPath).toLowerCase();
  if (!options.allowedExtensions.includes(extension)) {
    throw new AssetValidationError("asset_extension_not_allowed");
  }

  let stat: { isFile(): boolean; size: number };
  try {
    stat = fs.statSync(fullPath);
  } catch {
    throw new AssetValidationError("asset_not_found");
  }

  if (!stat.isFile()) {
    throw new AssetValidationError("asset_not_file");
  }
  if (stat.size > options.maxBytes) {
    throw new AssetValidationError("asset_too_large");
  }

  return fullPath;
}
