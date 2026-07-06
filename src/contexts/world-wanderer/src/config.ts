const fs = await import("node:fs");
const path = await import("node:path");

import type { WorldWandererConfig } from "./types.js";
import {
  defaultWorldWandererInitialLocation,
  defaultWorldWandererPluginConfigPath
} from "./types.js";
import { normalizeHeading, validLocation } from "./geo.js";
import {
  booleanValue,
  integerValue,
  locationValue,
  numberValue,
  parseJsonObject
} from "./values.js";

export function readWorldWandererConfig(configPath = defaultWorldWandererPluginConfigPath): WorldWandererConfig {
  const resolved = path.resolve(configPath);
  const parsed = fs.existsSync(resolved) ? parseJsonObject(fs.readFileSync(resolved, "utf8")) : {};
  return normalizeWorldWandererConfig(parsed);
}

export function publicWorldWandererConfig(config: WorldWandererConfig): WorldWandererConfig {
  return config;
}

export function validateWorldWandererConfig(config: WorldWandererConfig): string | undefined {
  if (typeof config.mapsJavaScriptApiKey !== "string") return "invalid_maps_javascript_api_key";
  if (!Number.isFinite(config.speedMetersPerSecond) || config.speedMetersPerSecond < 0 || config.speedMetersPerSecond > 10) return "invalid_speed";
  if (!validLocation(config.initialLocation)) return "invalid_initial_location";
  if (config.targetLocation && !validLocation(config.targetLocation)) return "invalid_target_location";
  if (!Number.isFinite(config.initialHeading) || config.initialHeading < 0 || config.initialHeading >= 360) return "invalid_initial_heading";
  if (!Number.isInteger(config.recentHistoryLimit) || config.recentHistoryLimit < 1 || config.recentHistoryLimit > 1000) return "invalid_recent_history_limit";
  if (!Number.isInteger(config.maxPanosPerIdle) || config.maxPanosPerIdle < 1 || config.maxPanosPerIdle > 100) return "invalid_max_panos_per_idle";
  if (!validWeight(config.noveltyWeight)) return "invalid_novelty_weight";
  if (!validWeight(config.forwardWeight)) return "invalid_forward_weight";
  if (!validWeight(config.roadContinuityWeight)) return "invalid_road_continuity_weight";
  if (!validWeight(config.uturnPenalty)) return "invalid_uturn_penalty";
  if (!validWeight(config.loopPenalty)) return "invalid_loop_penalty";
  if (!Number.isFinite(config.selectionTemperature) || config.selectionTemperature <= 0 || config.selectionTemperature > 100) return "invalid_selection_temperature";
  return undefined;
}

export function writeWorldWandererConfig(configPath: string, config: WorldWandererConfig): void {
  const validationError = validateWorldWandererConfig(config);
  if (validationError) throw new Error(validationError);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function normalizeWorldWandererConfig(parsed: Record<string, unknown>): WorldWandererConfig {
  const initialLocation = locationValue(parsed.initialLocation, defaultWorldWandererInitialLocation);
  return {
    enabled: booleanValue(parsed.enabled, false),
    libraryPrompt: typeof parsed.libraryPrompt === "string" ? parsed.libraryPrompt : "",
    mapsJavaScriptApiKey: typeof parsed.mapsJavaScriptApiKey === "string" ? parsed.mapsJavaScriptApiKey : "",
    speedMetersPerSecond: numberValue(parsed.speedMetersPerSecond, 1.4),
    initialLocation,
    targetLocation: locationValue(parsed.targetLocation, undefined),
    initialHeading: normalizeHeading(numberValue(parsed.initialHeading, 90)),
    recentHistoryLimit: integerValue(parsed.recentHistoryLimit, 500),
    maxPanosPerIdle: integerValue(parsed.maxPanosPerIdle, 10),
    noveltyWeight: numberValue(parsed.noveltyWeight, 6),
    forwardWeight: numberValue(parsed.forwardWeight, 2),
    roadContinuityWeight: numberValue(parsed.roadContinuityWeight, 1.5),
    uturnPenalty: numberValue(parsed.uturnPenalty, 6),
    loopPenalty: numberValue(parsed.loopPenalty, 10),
    selectionTemperature: numberValue(parsed.selectionTemperature, 1)
  };
}

function validWeight(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}
