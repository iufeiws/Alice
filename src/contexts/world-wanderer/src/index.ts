const fs = await import("node:fs");
const path = await import("node:path");

import type {
  GoogleStreetViewLocation,
  GoogleStreetViewMetadataResponse,
  GoogleStreetViewPlugin
} from "../../../channels/google-streetview/src/index.js";

export type WorldWandererConfig = {
  enabled: boolean;
  speedMetersPerSecond: number;
  headingJitterDegrees: number;
  initialLocation: GoogleStreetViewLocation;
  initialHeading: number;
};

export type WorldWandererState = {
  location: GoogleStreetViewLocation;
  lastHeading: number;
  metadata?: GoogleStreetViewMetadataResponse;
  metadataLocation?: GoogleStreetViewLocation;
  panoId?: string;
  lastFailure?: {
    message: string;
    at: string;
  };
  updatedAt: string;
};

export type WorldWandererRuntime = {
  runIdleTransition(input: { delayMs: number }): Promise<WorldWandererState | undefined>;
  getState(): WorldWandererState;
};

export type WorldWandererDeps = {
  configPath?: string;
  statePath: string;
  googleStreetView: Pick<GoogleStreetViewPlugin, "getMetadataByCoordinates">;
  now?(): Date;
  random?(): number;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export const defaultWorldWandererPluginConfigPath = "config/plugin/world-wanderer/config.json";
export const defaultWorldWandererInitialLocation: GoogleStreetViewLocation = {
  lat: 41.0086,
  lng: 28.9802
};

export function createWorldWandererRuntime(deps: WorldWandererDeps): WorldWandererRuntime {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());

  return {
    async runIdleTransition(input) {
      const config = readWorldWandererConfig(deps.configPath);
      if (!config.enabled) return undefined;

      const previous = readWorldWandererState(deps.statePath, config, now);
      const heading = normalizeHeading(previous.lastHeading + ((random() * 2) - 1) * config.headingJitterDegrees);
      const distanceMeters = Math.max(0, input.delayMs) / 1000 * config.speedMetersPerSecond;
      const location = moveLocation(previous.location, heading, distanceMeters);
      const updatedAt = now().toISOString();
      let next: WorldWandererState = {
        ...previous,
        location,
        lastHeading: heading,
        updatedAt
      };

      try {
        const result = await deps.googleStreetView.getMetadataByCoordinates(location);
        next = {
          location,
          lastHeading: heading,
          metadata: result.metadata,
          metadataLocation: result.location,
          panoId: result.panoId,
          updatedAt
        };
        deps.appendLog?.("info", `world wanderer moved: lat=${location.lat.toFixed(6)} lng=${location.lng.toFixed(6)} heading=${heading.toFixed(1)}`);
      } catch (error) {
        const lastFailure = {
          message: error instanceof Error ? error.message : String(error),
          at: updatedAt
        };
        next = {
          ...next,
          lastFailure
        };
        deps.appendLog?.("warn", `world wanderer metadata failed: ${lastFailure.message}`);
      }

      writeWorldWandererState(deps.statePath, next);
      return next;
    },
    getState() {
      return readWorldWandererState(deps.statePath, readWorldWandererConfig(deps.configPath), now);
    }
  };
}

export function readWorldWandererConfig(configPath = defaultWorldWandererPluginConfigPath): WorldWandererConfig {
  const resolved = path.resolve(configPath);
  const parsed = fs.existsSync(resolved) ? parseJsonObject(fs.readFileSync(resolved, "utf8")) : {};
  return normalizeWorldWandererConfig(parsed);
}

export function publicWorldWandererConfig(config: WorldWandererConfig): WorldWandererConfig {
  return config;
}

export function validateWorldWandererConfig(config: WorldWandererConfig): string | undefined {
  if (!Number.isFinite(config.speedMetersPerSecond) || config.speedMetersPerSecond < 0 || config.speedMetersPerSecond > 10) return "invalid_speed";
  if (!Number.isFinite(config.headingJitterDegrees) || config.headingJitterDegrees < 0 || config.headingJitterDegrees > 180) return "invalid_heading_jitter";
  if (!validLocation(config.initialLocation)) return "invalid_initial_location";
  if (!Number.isFinite(config.initialHeading) || config.initialHeading < 0 || config.initialHeading >= 360) return "invalid_initial_heading";
  return undefined;
}

export function writeWorldWandererConfig(configPath: string, config: WorldWandererConfig): void {
  const validationError = validateWorldWandererConfig(config);
  if (validationError) throw new Error(validationError);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function readWorldWandererState(statePath: string, config: WorldWandererConfig, now: () => Date = () => new Date()): WorldWandererState {
  const resolved = path.resolve(statePath);
  const parsed = fs.existsSync(resolved) ? parseJsonObject(fs.readFileSync(resolved, "utf8")) : {};
  return normalizeWorldWandererState(parsed, config, now);
}

export function writeWorldWandererState(statePath: string, state: WorldWandererState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function moveLocation(location: GoogleStreetViewLocation, headingDegrees: number, distanceMeters: number): GoogleStreetViewLocation {
  const earthRadiusMeters = 6_371_000;
  const angularDistance = distanceMeters / earthRadiusMeters;
  const bearing = degreesToRadians(headingDegrees);
  const lat1 = degreesToRadians(location.lat);
  const lng1 = degreesToRadians(location.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
      + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  return {
    lat: radiansToDegrees(lat2),
    lng: normalizeLongitude(radiansToDegrees(lng2))
  };
}

function normalizeWorldWandererConfig(parsed: Record<string, unknown>): WorldWandererConfig {
  const initialLocation = locationValue(parsed.initialLocation, defaultWorldWandererInitialLocation);
  return {
    enabled: booleanValue(parsed.enabled, false),
    speedMetersPerSecond: numberValue(parsed.speedMetersPerSecond, 1.4),
    headingJitterDegrees: numberValue(parsed.headingJitterDegrees, 30),
    initialLocation,
    initialHeading: normalizeHeading(numberValue(parsed.initialHeading, 90))
  };
}

function normalizeWorldWandererState(raw: Record<string, unknown>, config: WorldWandererConfig, now: () => Date): WorldWandererState {
  const location = locationValue(raw.location, config.initialLocation);
  return {
    location,
    lastHeading: normalizeHeading(numberValue(raw.lastHeading, config.initialHeading)),
    metadata: objectValue(raw.metadata) as GoogleStreetViewMetadataResponse | undefined,
    metadataLocation: locationValue(raw.metadataLocation, undefined),
    panoId: stringValue(raw.panoId),
    lastFailure: failureValue(raw.lastFailure),
    updatedAt: stringValue(raw.updatedAt) ?? now().toISOString()
  };
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function locationValue(value: unknown, fallback: GoogleStreetViewLocation): GoogleStreetViewLocation;
function locationValue(value: unknown, fallback: undefined): GoogleStreetViewLocation | undefined;
function locationValue(value: unknown, fallback: GoogleStreetViewLocation | undefined): GoogleStreetViewLocation | undefined {
  const object = objectValue(value);
  const lat = object ? numberValue(object.lat, Number.NaN) : Number.NaN;
  const lng = object ? numberValue(object.lng, Number.NaN) : Number.NaN;
  if (validLocation({ lat, lng })) return { lat, lng };
  return fallback;
}

function failureValue(value: unknown): WorldWandererState["lastFailure"] {
  const object = objectValue(value);
  const message = object ? stringValue(object.message) : undefined;
  const at = object ? stringValue(object.at) : undefined;
  return message && at ? { message, at } : undefined;
}

function validLocation(location: GoogleStreetViewLocation): boolean {
  return Number.isFinite(location.lat) && Number.isFinite(location.lng)
    && location.lat >= -90 && location.lat <= 90
    && location.lng >= -180 && location.lng <= 180;
}

function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

function normalizeLongitude(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
