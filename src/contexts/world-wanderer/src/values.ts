import type { GoogleStreetViewLocation } from "../../../channels/google-streetview/src/index.js";
import { validLocation } from "./geo.js";

export function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function integerValue(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? value as number : fallback;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function locationValue(value: unknown, fallback: GoogleStreetViewLocation): GoogleStreetViewLocation;
export function locationValue(value: unknown, fallback: undefined): GoogleStreetViewLocation | undefined;
export function locationValue(value: unknown, fallback: GoogleStreetViewLocation | undefined): GoogleStreetViewLocation | undefined {
  const object = objectValue(value);
  const lat = object ? numberValue(object.lat, Number.NaN) : Number.NaN;
  const lng = object ? numberValue(object.lng, Number.NaN) : Number.NaN;
  if (validLocation({ lat, lng })) return { lat, lng };
  return fallback;
}
