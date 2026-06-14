const fs = await import("node:fs");
const path = await import("node:path");

import type {
  GoogleStreetViewPluginConfig,
  GoogleStreetViewPluginPublicConfig
} from "./types.js";
import { booleanValue, numberValue, parseJsonObject, stringValue } from "./internal.js";
import { regionListValue } from "./geo.js";

export const defaultGoogleStreetViewPluginConfigPath = "config/plugin/google-streetview/config.json";
export const defaultGoogleStreetViewOutputDir = "assets/plugin/google-streetview";

export function readGoogleStreetViewPluginConfig(
  configPath = defaultGoogleStreetViewPluginConfigPath,
  defaults: Partial<GoogleStreetViewPluginConfig> = {},
  env: Record<string, string | undefined> = process.env
): GoogleStreetViewPluginConfig {
  const resolved = path.resolve(configPath);
  const parsed = fs.existsSync(resolved) ? parseJsonObject(fs.readFileSync(resolved, "utf8")) : {};
  return normalizeGoogleStreetViewPluginConfig(parsed, { ...envDefaults(env), ...defaults });
}

export function publicGoogleStreetViewPluginConfig(config: GoogleStreetViewPluginConfig): GoogleStreetViewPluginPublicConfig {
  const { apiKey, ...publicConfig } = config;
  return {
    ...publicConfig,
    apiKeySet: Boolean(apiKey)
  };
}

export function normalizeGoogleStreetViewPluginConfig(
  parsed: Record<string, unknown>,
  defaults: Partial<GoogleStreetViewPluginConfig> = {}
): GoogleStreetViewPluginConfig {
  return {
    enabled: booleanValue(parsed.enabled, defaults.enabled ?? true),
    apiKey: stringValue(parsed.apiKey, defaults.apiKey),
    imageSize: stringValue(parsed.imageSize, defaults.imageSize ?? "640x640")!,
    heading: numberValue(parsed.heading, defaults.heading ?? 0),
    pitch: numberValue(parsed.pitch, defaults.pitch ?? 0),
    fov: numberValue(parsed.fov, defaults.fov ?? 90),
    initialRadiusMeters: numberValue(parsed.initialRadiusMeters, defaults.initialRadiusMeters ?? 50),
    radiusExpansionFactor: numberValue(parsed.radiusExpansionFactor, defaults.radiusExpansionFactor ?? 2),
    maxRadiusMeters: numberValue(parsed.maxRadiusMeters, defaults.maxRadiusMeters ?? 1000),
    randomAttempts: numberValue(parsed.randomAttempts, defaults.randomAttempts ?? 8),
    coordinatePrecision: Math.trunc(numberValue(parsed.coordinatePrecision, defaults.coordinatePrecision ?? 5)),
    outputDir: stringValue(parsed.outputDir, defaults.outputDir ?? defaultGoogleStreetViewOutputDir)!,
    regions: regionListValue(parsed.regions, defaults.regions ?? [])
  };
}

export function validateGoogleStreetViewPluginConfig(config: GoogleStreetViewPluginConfig): string | undefined {
  if (!config.outputDir || !isAllowedOutputDir(config.outputDir)) return "invalid_output_dir";
  if (!/^\d+x\d+$/.test(config.imageSize)) return "invalid_image_size";
  if (config.initialRadiusMeters < 0 || config.initialRadiusMeters > 50_000) return "invalid_initial_radius";
  if (config.radiusExpansionFactor <= 1 || config.radiusExpansionFactor > 10) return "invalid_radius_expansion_factor";
  if (config.maxRadiusMeters < config.initialRadiusMeters || config.maxRadiusMeters > 100_000) return "invalid_max_radius";
  if (config.randomAttempts < 1 || config.randomAttempts > 100) return "invalid_random_attempts";
  if (config.coordinatePrecision < 0 || config.coordinatePrecision > 7) return "invalid_coordinate_precision";
  if (config.fov < 10 || config.fov > 120) return "invalid_fov";
  if (config.pitch < -90 || config.pitch > 90) return "invalid_pitch";
  for (const region of config.regions) {
    if (!region.id) return "invalid_region";
    if (region.bounds.north < region.bounds.south) return "invalid_region_bounds";
    if (region.bounds.north > 90 || region.bounds.south < -90 || region.bounds.east > 180 || region.bounds.west < -180) return "invalid_region_bounds";
  }
  return undefined;
}

export function envDefaults(env: Record<string, string | undefined>): Partial<GoogleStreetViewPluginConfig> {
  return {
    apiKey: env.GOOGLE_STREETVIEW_API_KEY
  };
}

function isAllowedOutputDir(outputDir: string): boolean {
  const resolved = path.resolve(outputDir);
  const allowedRoot = path.resolve(defaultGoogleStreetViewOutputDir);
  const generatedRoot = path.resolve("assets/generated");
  const relative = path.relative(allowedRoot, resolved);
  const generatedRelative = path.relative(generatedRoot, resolved);
  return (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    && !(generatedRelative === "" || (!generatedRelative.startsWith("..") && !path.isAbsolute(generatedRelative)));
}
