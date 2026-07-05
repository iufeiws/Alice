import { defaultGoogleStreetViewPluginConfigPath, publicGoogleStreetViewPluginConfig, readGoogleStreetViewPluginConfig, validateGoogleStreetViewPluginConfig, type GoogleStreetViewPluginConfig, type GoogleStreetViewRegion } from "../../../channels/google-streetview/src/index.js";
import { defaultWorldWandererPluginConfigPath, publicWorldWandererConfig, readWorldWandererConfig, readWorldWandererState, validateWorldWandererConfig, writeWorldWandererConfig, type WorldWandererConfig } from "../../world-wanderer/src/index.js";
import { booleanFromUnknown, numberFromUnknown, optionalString, requiredString } from "../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import type { AdminPluginRegistryEntry, AdminPluginSummary } from "./admin-plugin-types.js";
import { secretStringFromUnknown } from "./admin-plugin-utils.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function googleStreetViewPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return googleStreetViewPluginSummary(context);
    },
    config(context) {
      return publicGoogleStreetViewPluginConfig(readGoogleStreetViewConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateGoogleStreetViewConfig(context, patch);
      return "error" in result ? result : { config: publicGoogleStreetViewPluginConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateGoogleStreetViewConfig(context, { enabled });
      return "error" in result ? result : { config: publicGoogleStreetViewPluginConfig(result.config) };
    },
    reload(context) {
      return { config: publicGoogleStreetViewPluginConfig(readGoogleStreetViewConfigForAdmin(context)) };
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "request", label: "Request" },
        { key: "storage", label: "Storage" },
        { key: "regions", label: "Regions" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Enable or disable the Google Street View channel plugin." },
        { key: "apiKeySet", label: "API Key Set", type: "readonly", group: "general" },
        { key: "apiKey", label: "API Key", type: "password", group: "general", description: "Leave blank to keep the current key. The key must allow Street View Static API and Map Tiles API." },
        { key: "imageSize", label: "Image Size", type: "text", group: "request", description: "Google Static Street View size, for example 640x640." },
        { key: "heading", label: "Heading", type: "number", group: "request", min: 0, max: 360, step: 1 },
        { key: "pitch", label: "Pitch", type: "number", group: "request", min: -90, max: 90, step: 1 },
        { key: "fov", label: "FOV", type: "number", group: "request", min: 10, max: 120, step: 1 },
        { key: "initialRadiusMeters", label: "Initial Radius Meters", type: "number", group: "request", min: 0, max: 50000, step: 1 },
        { key: "radiusExpansionFactor", label: "Radius Expansion Factor", type: "number", group: "request", min: 1.01, max: 10, step: 0.01 },
        { key: "maxRadiusMeters", label: "Max Radius Meters", type: "number", group: "request", min: 1, max: 100000, step: 1 },
        { key: "randomAttempts", label: "Random Attempts", type: "number", group: "request", min: 1, max: 100, step: 1 },
        { key: "coordinatePrecision", label: "Coordinate Precision", type: "number", group: "request", min: 0, max: 7, step: 1 },
        { key: "outputDir", label: "Output Folder", type: "text", group: "storage", description: "Must stay under assets/plugin/google-streetview and must not use assets/generated." },
        { key: "regions", label: "Regions JSON", type: "textarea", group: "regions", description: "Array of { id, label, bounds: { north, south, east, west } } entries." }
      ]
    },
    routePreview: [
      "google_streetview.getStreetViewByCoordinates / getRandomStreetView",
      "google_streetview.getPanoGraphByCoordinates / getPanoGraphByPanoId",
      "metadata preflight and radius expansion",
      "Map Tiles Street View metadata links",
      "static street view image download",
      "plugin-owned asset storage"
    ],
    runtimeAccess: [
      "read plugin config",
      "call Google Street View Static API and Map Tiles API metadata endpoints",
      "write images and metadata under assets/plugin/google-streetview",
      "reuse stored metadata when requested"
    ]
  };
}

function googleStreetViewPluginSummary(context: AdminRoutesContext, config = readGoogleStreetViewConfigForAdmin(context)): AdminPluginSummary {
  const validationError = validateGoogleStreetViewPluginConfig(config);
  const missingConfig = config.enabled && !config.apiKey;
  return {
    id: "google_streetview",
    name: "Google Street View",
    kind: "channel",
    status: validationError || missingConfig ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: validationError || missingConfig ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Fetch Google Static Street View images and Map Tiles pano graph metadata into plugin-owned flows.",
    configurable: true,
    switchable: true,
    configSource: googleStreetViewConfigPath(context),
    lastLoadedAt: googleStreetViewConfigMtime(context)
  };
}

function updateGoogleStreetViewConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: GoogleStreetViewPluginConfig } | { error: string } {
  const current = readGoogleStreetViewConfigForAdmin(context);
  let regions: GoogleStreetViewRegion[];
  try {
    regions = patch.regions === undefined ? current.regions : googleStreetViewRegionsFromUnknown(patch.regions, current.regions);
  } catch {
    return { error: "invalid_regions" };
  }
  const next: GoogleStreetViewPluginConfig = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    apiKey: patch.apiKey === undefined ? current.apiKey : secretStringFromUnknown(patch.apiKey, current.apiKey),
    imageSize: patch.imageSize === undefined ? current.imageSize : requiredString(patch.imageSize).trim(),
    heading: patch.heading === undefined ? current.heading : numberFromUnknown(patch.heading, current.heading),
    pitch: patch.pitch === undefined ? current.pitch : numberFromUnknown(patch.pitch, current.pitch),
    fov: patch.fov === undefined ? current.fov : numberFromUnknown(patch.fov, current.fov),
    initialRadiusMeters: patch.initialRadiusMeters === undefined ? current.initialRadiusMeters : numberFromUnknown(patch.initialRadiusMeters, current.initialRadiusMeters),
    radiusExpansionFactor: patch.radiusExpansionFactor === undefined ? current.radiusExpansionFactor : numberFromUnknown(patch.radiusExpansionFactor, current.radiusExpansionFactor),
    maxRadiusMeters: patch.maxRadiusMeters === undefined ? current.maxRadiusMeters : numberFromUnknown(patch.maxRadiusMeters, current.maxRadiusMeters),
    randomAttempts: patch.randomAttempts === undefined ? current.randomAttempts : numberFromUnknown(patch.randomAttempts, current.randomAttempts),
    coordinatePrecision: patch.coordinatePrecision === undefined ? current.coordinatePrecision : numberFromUnknown(patch.coordinatePrecision, current.coordinatePrecision),
    outputDir: patch.outputDir === undefined ? current.outputDir : requiredString(patch.outputDir).trim(),
    regions
  };

  if ([
    next.heading,
    next.pitch,
    next.fov,
    next.initialRadiusMeters,
    next.radiusExpansionFactor,
    next.maxRadiusMeters,
    next.randomAttempts,
    next.coordinatePrecision
  ].some((value) => !Number.isFinite(value))) return { error: "invalid_google_streetview_number" };

  const validationError = validateGoogleStreetViewPluginConfig(next);
  if (validationError) return { error: validationError };
  writeGoogleStreetViewConfig(context, next);
  return { config: next };
}

function googleStreetViewRegionsFromUnknown(value: unknown, fallback: GoogleStreetViewRegion[]): GoogleStreetViewRegion[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error("invalid_regions");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid_region");
    const region = entry as { id?: unknown; label?: unknown; bounds?: unknown };
    if (!region.bounds || typeof region.bounds !== "object") throw new Error("invalid_region");
    const bounds = region.bounds as Record<string, unknown>;
    return {
      id: requiredString(region.id).trim(),
      label: optionalString(region.label),
      bounds: {
        north: numberFromUnknown(bounds.north, Number.NaN),
        south: numberFromUnknown(bounds.south, Number.NaN),
        east: numberFromUnknown(bounds.east, Number.NaN),
        west: numberFromUnknown(bounds.west, Number.NaN)
      }
    };
  });
}

function readGoogleStreetViewConfigForAdmin(context: AdminRoutesContext): GoogleStreetViewPluginConfig {
  return readGoogleStreetViewPluginConfig(googleStreetViewConfigPath(context));
}

function writeGoogleStreetViewConfig(context: AdminRoutesContext, config: GoogleStreetViewPluginConfig): void {
  const filePath = googleStreetViewConfigPath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function googleStreetViewConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.googleStreetView?.configPath ?? defaultGoogleStreetViewPluginConfigPath;
}

function googleStreetViewConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(googleStreetViewConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}

export function worldWandererPluginEntry(): AdminPluginRegistryEntry {
  return {
    summary(context) {
      return worldWandererPluginSummary(context);
    },
    config(context) {
      return publicWorldWandererConfig(readWorldWandererConfigForAdmin(context));
    },
    patch(context, patch) {
      const result = updateWorldWandererConfig(context, patch);
      return "error" in result ? result : { config: publicWorldWandererConfig(result.config) };
    },
    setEnabled(context, enabled) {
      const result = updateWorldWandererConfig(context, { enabled });
      return "error" in result ? result : { config: publicWorldWandererConfig(result.config) };
    },
    reload(context) {
      return { config: publicWorldWandererConfig(readWorldWandererConfigForAdmin(context)) };
    },
    runtimeState(context) {
      const config = readWorldWandererConfigForAdmin(context);
      return readWorldWandererAdminState(context, config);
    },
    configSchema: {
      groups: [
        { key: "general", label: "General" },
        { key: "movement", label: "Graph Movement" },
        { key: "policy", label: "Policy" },
        { key: "initial", label: "Initial Position" }
      ],
      fields: [
        { key: "enabled", label: "Enabled", type: "switch", group: "general", description: "Move world-wanderer state on idle timer transitions." },
        { key: "libraryPrompt", label: "Library Prompt", type: "textarea", group: "general", description: "Used as library.content while World Wanderer is enabled. Empty stays empty." },
        { key: "mapsJavaScriptApiKey", label: "Maps JavaScript API Key", type: "text", group: "general", description: "Browser-visible key for the admin map." },
        { key: "speedMetersPerSecond", label: "Speed Meters Per Second", type: "number", group: "movement", min: 0, max: 10, step: 0.1 },
        { key: "recentHistoryLimit", label: "Recent History Limit", type: "number", group: "movement", min: 1, max: 1000, step: 1 },
        { key: "maxPanosPerIdle", label: "Max Panos Per Idle", type: "number", group: "movement", min: 1, max: 100, step: 1 },
        { key: "noveltyWeight", label: "Novelty Weight", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "forwardWeight", label: "Forward Weight", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "roadContinuityWeight", label: "Road Continuity Weight", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "uturnPenalty", label: "U-turn Penalty", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "loopPenalty", label: "Loop Penalty", type: "number", group: "policy", min: 0, max: 100, step: 0.1 },
        { key: "selectionTemperature", label: "Selection Temperature", type: "number", group: "policy", min: 0.01, max: 100, step: 0.01 },
        { key: "initialLocation", label: "Initial Location JSON", type: "textarea", group: "initial", description: "Object with lat and lng. Defaults near Hagia Sophia." },
        { key: "initialHeading", label: "Initial Heading", type: "number", group: "initial", min: 0, max: 359, step: 1 }
      ]
    },
    routePreview: [
      "idle timer pano graph movement",
      "google_streetview.getPanoGraphByCoordinates / getPanoGraphByPanoId"
    ],
    runtimeAccess: [
      "read plugin config",
      "write world wanderer state under memory state",
      "call Google Street View pano graph metadata through google_streetview"
    ]
  };
}

function worldWandererPluginSummary(context: AdminRoutesContext, config = readWorldWandererConfigForAdmin(context)): AdminPluginSummary {
  const validationError = validateWorldWandererConfig(config);
  return {
    id: "world_wanderer",
    name: "World Wanderer",
    kind: "context",
    status: validationError ? "missing_config" : config.enabled ? "enabled" : "disabled",
    health: validationError ? "degraded" : config.enabled ? "healthy" : "unknown",
    description: "Persistently moves across Google Street View pano graph links during idle timer transitions.",
    configurable: true,
    switchable: true,
    configSource: worldWandererConfigPath(context),
    lastLoadedAt: worldWandererConfigMtime(context)
  };
}

function updateWorldWandererConfig(context: AdminRoutesContext, patch: Record<string, unknown>): { config: WorldWandererConfig } | { error: string } {
  const current = readWorldWandererConfigForAdmin(context);
  let initialLocation = current.initialLocation;
  try {
    initialLocation = patch.initialLocation === undefined ? current.initialLocation : worldWandererLocationFromUnknown(patch.initialLocation, current.initialLocation);
  } catch {
    return { error: "invalid_initial_location" };
  }
  const next: WorldWandererConfig = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : booleanFromUnknown(patch.enabled),
    libraryPrompt: patch.libraryPrompt === undefined ? current.libraryPrompt : requiredString(patch.libraryPrompt),
    mapsJavaScriptApiKey: patch.mapsJavaScriptApiKey === undefined ? current.mapsJavaScriptApiKey : requiredString(patch.mapsJavaScriptApiKey).trim(),
    speedMetersPerSecond: patch.speedMetersPerSecond === undefined ? current.speedMetersPerSecond : numberFromUnknown(patch.speedMetersPerSecond, current.speedMetersPerSecond),
    initialLocation,
    initialHeading: patch.initialHeading === undefined ? current.initialHeading : numberFromUnknown(patch.initialHeading, current.initialHeading),
    recentHistoryLimit: patch.recentHistoryLimit === undefined ? current.recentHistoryLimit : numberFromUnknown(patch.recentHistoryLimit, current.recentHistoryLimit),
    maxPanosPerIdle: patch.maxPanosPerIdle === undefined ? current.maxPanosPerIdle : numberFromUnknown(patch.maxPanosPerIdle, current.maxPanosPerIdle),
    noveltyWeight: patch.noveltyWeight === undefined ? current.noveltyWeight : numberFromUnknown(patch.noveltyWeight, current.noveltyWeight),
    forwardWeight: patch.forwardWeight === undefined ? current.forwardWeight : numberFromUnknown(patch.forwardWeight, current.forwardWeight),
    roadContinuityWeight: patch.roadContinuityWeight === undefined ? current.roadContinuityWeight : numberFromUnknown(patch.roadContinuityWeight, current.roadContinuityWeight),
    uturnPenalty: patch.uturnPenalty === undefined ? current.uturnPenalty : numberFromUnknown(patch.uturnPenalty, current.uturnPenalty),
    loopPenalty: patch.loopPenalty === undefined ? current.loopPenalty : numberFromUnknown(patch.loopPenalty, current.loopPenalty),
    selectionTemperature: patch.selectionTemperature === undefined ? current.selectionTemperature : numberFromUnknown(patch.selectionTemperature, current.selectionTemperature)
  };

  if ([
    next.speedMetersPerSecond,
    next.initialHeading,
    next.recentHistoryLimit,
    next.maxPanosPerIdle,
    next.noveltyWeight,
    next.forwardWeight,
    next.roadContinuityWeight,
    next.uturnPenalty,
    next.loopPenalty,
    next.selectionTemperature
  ].some((value) => !Number.isFinite(value))) return { error: "invalid_world_wanderer_number" };

  const validationError = validateWorldWandererConfig(next);
  if (validationError) return { error: validationError };
  writeWorldWandererConfig(worldWandererConfigPath(context), next);
  return { config: next };
}

function worldWandererLocationFromUnknown(value: unknown, fallback: { lat: number; lng: number }): { lat: number; lng: number } {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_initial_location");
  const object = parsed as Record<string, unknown>;
  return {
    lat: numberFromUnknown(object.lat, Number.NaN),
    lng: numberFromUnknown(object.lng, Number.NaN)
  };
}

function readWorldWandererConfigForAdmin(context: AdminRoutesContext): WorldWandererConfig {
  return readWorldWandererConfig(worldWandererConfigPath(context));
}

function worldWandererConfigPath(context: AdminRoutesContext): string {
  return context.pluginConfigs?.worldWanderer?.configPath ?? defaultWorldWandererPluginConfigPath;
}

function worldWandererDbPath(context: AdminRoutesContext): string {
  return path.join(context.config.memoryFiles.root, "alice.sqlite");
}

function readWorldWandererAdminState(context: AdminRoutesContext, config: WorldWandererConfig): unknown {
  const dbPath = worldWandererDbPath(context);
  return fs.existsSync(dbPath)
    ? readWorldWandererState(dbPath, config)
    : { location: config.initialLocation, lastHeading: config.initialHeading, pathStack: [] };
}

function worldWandererConfigMtime(context: AdminRoutesContext): string | undefined {
  try {
    const stats = fs.statSync(worldWandererConfigPath(context)) as { mtime?: Date; mtimeMs?: number };
    if (stats.mtime instanceof Date) return stats.mtime.toISOString();
    if (typeof stats.mtimeMs === "number") return new Date(stats.mtimeMs).toISOString();
    return undefined;
  } catch {
    return undefined;
  }
}
