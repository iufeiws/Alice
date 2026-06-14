import type {
  GoogleStreetViewLocation,
  GoogleStreetViewMetadataResponse,
  GoogleStreetViewPluginConfig,
  GoogleStreetViewRegion
} from "./types.js";
import { numberValue, stringValue } from "./internal.js";

export function findRegion(config: GoogleStreetViewPluginConfig, regionId: string): GoogleStreetViewRegion {
  const region = config.regions.find((entry) => entry.id === regionId);
  if (!region) throw new Error(`unknown google streetview region: ${regionId}`);
  return region;
}

export function randomLocationInRegion(region: GoogleStreetViewRegion, random: () => number): GoogleStreetViewLocation {
  return {
    lat: region.bounds.south + random() * (region.bounds.north - region.bounds.south),
    lng: region.bounds.west + random() * (region.bounds.east - region.bounds.west)
  };
}

export function bucketForLocation(location: GoogleStreetViewLocation, precision: number): string {
  const factor = 10 ** precision;
  const lat = Math.round(location.lat * factor) / factor;
  const lng = Math.round(location.lng * factor) / factor;
  return `${lat.toFixed(precision)},${lng.toFixed(precision)}`;
}

export function normalizeLocation(input: unknown): GoogleStreetViewLocation {
  if (!input || typeof input !== "object") throw new Error("location is required");
  const value = input as { lat?: unknown; lng?: unknown };
  const lat = numberValue(value.lat, Number.NaN);
  const lng = numberValue(value.lng, Number.NaN);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error("invalid latitude");
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error("invalid longitude");
  return { lat, lng };
}

export function normalizeMetadataLocation(metadata: GoogleStreetViewMetadataResponse, fallback: GoogleStreetViewLocation): GoogleStreetViewLocation {
  const lat = typeof metadata.location?.lat === "number" ? metadata.location.lat : fallback.lat;
  const lng = typeof metadata.location?.lng === "number" ? metadata.location.lng : fallback.lng;
  return normalizeLocation({ lat, lng });
}

export function formatLocation(location: GoogleStreetViewLocation): string {
  return `${location.lat},${location.lng}`;
}

export function regionListValue(value: unknown, fallback: GoogleStreetViewRegion[]): GoogleStreetViewRegion[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((entry) => normalizeRegion(entry)).filter((entry): entry is GoogleStreetViewRegion => Boolean(entry));
}

function normalizeRegion(value: unknown): GoogleStreetViewRegion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { id?: unknown; label?: unknown; bounds?: unknown };
  const id = stringValue(entry.id);
  if (!id || !entry.bounds || typeof entry.bounds !== "object") return undefined;
  const bounds = entry.bounds as Record<string, unknown>;
  return {
    id,
    label: stringValue(entry.label),
    bounds: {
      north: numberValue(bounds.north, Number.NaN),
      south: numberValue(bounds.south, Number.NaN),
      east: numberValue(bounds.east, Number.NaN),
      west: numberValue(bounds.west, Number.NaN)
    }
  };
}
