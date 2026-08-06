import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadPiModule(packageRoot) {
  const entryPath = resolvePiPackageEntry(packageRoot);
  return import(pathToFileURL(entryPath).href);
}

export function readPiPackageVersion(packageRoot) {
  const manifest = readManifest(packageRoot);
  if (typeof manifest.version !== "string" || !manifest.version) throw new Error("pi_package_version_unavailable");
  return manifest.version;
}

export function resolvePiPackageEntry(packageRoot) {
  const manifest = readManifest(packageRoot);
  const exportTarget = resolveExportTarget(manifest.exports);
  const relativeEntry = exportTarget || manifest.module || manifest.main;
  if (typeof relativeEntry !== "string" || !relativeEntry) throw new Error("pi_package_entry_unavailable");
  return path.resolve(packageRoot, relativeEntry);
}

function readManifest(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
}

function resolveExportTarget(exportsField) {
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return resolveConditionalTarget(exportsField);
  if (!exportsField || typeof exportsField !== "object") return undefined;
  const rootExport = Object.prototype.hasOwnProperty.call(exportsField, ".") ? exportsField["."] : exportsField;
  return resolveConditionalTarget(rootExport);
}

function resolveConditionalTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveConditionalTarget(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!target || typeof target !== "object") return undefined;
  for (const condition of ["import", "node", "default", "require"]) {
    const resolved = resolveConditionalTarget(target[condition]);
    if (resolved) return resolved;
  }
  return undefined;
}
