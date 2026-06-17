const fs = await import("node:fs");
const path = await import("node:path");

import type {
  GoogleStreetViewPanoGraphMetadataResponse,
  GoogleStreetViewPanoGraphResult
} from "../../../channels/google-streetview/src/index.js";
import type {
  WorldWandererConfig,
  WorldWandererPathEntry,
  WorldWandererState
} from "./types.js";
import { normalizeHeading } from "./geo.js";
import {
  locationValue,
  numberValue,
  objectValue,
  parseJsonObject,
  stringValue
} from "./values.js";

export function readWorldWandererState(statePath: string, config: WorldWandererConfig, now: () => Date = () => new Date()): WorldWandererState {
  const resolved = path.resolve(statePath);
  const parsed = fs.existsSync(resolved) ? parseJsonObject(fs.readFileSync(resolved, "utf8")) : {};
  return normalizeWorldWandererState(parsed, config, now);
}

export function writeWorldWandererState(statePath: string, state: WorldWandererState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function stateFromPano(input: {
  pano: GoogleStreetViewPanoGraphResult;
  lastHeading: number;
  lastRoadText?: string;
  recentPanoIds: string[];
  pathStack: WorldWandererPathEntry[];
  updatedAt: string;
}): WorldWandererState {
  return {
    location: input.pano.location,
    lastHeading: normalizeHeading(input.lastHeading),
    lastRoadText: input.lastRoadText,
    metadata: input.pano.metadata,
    metadataLocation: input.pano.location,
    panoId: input.pano.panoId,
    recentPanoIds: input.recentPanoIds,
    pathStack: input.pathStack,
    updatedAt: input.updatedAt
  };
}

export function appendRecentPanoId(values: string[], panoId: string | undefined, limit: number): string[] {
  if (!panoId) return values.slice(-limit);
  return [...values, panoId].slice(-limit);
}

export function pushPathStack(values: WorldWandererPathEntry[], pano: GoogleStreetViewPanoGraphResult, limit: number): WorldWandererPathEntry[] {
  return [...values, {
    panoId: pano.panoId,
    location: pano.location,
    heading: pano.heading
  }].slice(-limit);
}

function normalizeWorldWandererState(raw: Record<string, unknown>, config: WorldWandererConfig, now: () => Date): WorldWandererState {
  const location = locationValue(raw.location, config.initialLocation);
  return {
    location,
    lastHeading: normalizeHeading(numberValue(raw.lastHeading, config.initialHeading)),
    lastRoadText: stringValue(raw.lastRoadText),
    metadata: objectValue(raw.metadata) as GoogleStreetViewPanoGraphMetadataResponse | undefined,
    metadataLocation: locationValue(raw.metadataLocation, undefined),
    panoId: stringValue(raw.panoId),
    recentPanoIds: stringArrayValue(raw.recentPanoIds, config.recentHistoryLimit),
    pathStack: pathStackValue(raw.pathStack, config.recentHistoryLimit),
    lastFailure: failureValue(raw.lastFailure),
    updatedAt: stringValue(raw.updatedAt) ?? now().toISOString()
  };
}

function stringArrayValue(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).slice(-limit);
}

function pathStackValue(value: unknown, limit: number): WorldWandererPathEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") return undefined;
    const object = entry as Record<string, unknown>;
    const panoId = stringValue(object.panoId);
    const location = locationValue(object.location, undefined);
    if (!panoId || !location) return undefined;
    return {
      panoId,
      location,
      heading: normalizeHeading(numberValue(object.heading, 0))
    };
  }).filter((entry): entry is WorldWandererPathEntry => Boolean(entry)).slice(-limit);
}

function failureValue(value: unknown): WorldWandererState["lastFailure"] {
  const object = objectValue(value);
  const message = object ? stringValue(object.message) : undefined;
  const at = object ? stringValue(object.at) : undefined;
  return message && at ? { message, at } : undefined;
}
