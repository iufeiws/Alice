import type {
  GoogleStreetViewLocation,
  GoogleStreetViewMetadataResponse,
  GoogleStreetViewPanoGraphMetadataResponse,
  GoogleStreetViewPanoGraphResult,
  GoogleStreetViewPluginConfig
} from "./types.js";
import { formatLocation, normalizeLocation } from "./geo.js";

export type GoogleStreetViewMapTilesSession = {
  token: string;
  expiryMs: number;
  apiKey?: string;
};

export async function findAvailableMetadata(input: {
  config: GoogleStreetViewPluginConfig;
  requestedLocation: GoogleStreetViewLocation;
  fetchImpl: typeof fetch;
}): Promise<GoogleStreetViewMetadataResponse> {
  let radius = input.config.initialRadiusMeters;
  const maxRadius = input.config.maxRadiusMeters;
  while (radius <= maxRadius) {
    const response = await input.fetchImpl(metadataUrl(input.config, input.requestedLocation, radius));
    if (!response.ok) throw new Error(`google streetview metadata request failed: HTTP ${response.status} ${response.statusText}`);
    const metadata = await response.json() as GoogleStreetViewMetadataResponse;
    if (metadata.status === "OK") return metadata;
    if (radius === maxRadius) break;
    radius = Math.min(maxRadius, Math.max(radius + 1, Math.ceil(radius * input.config.radiusExpansionFactor)));
  }
  throw new Error(`google streetview metadata returned no imagery near ${formatLocation(input.requestedLocation)}`);
}

export function staticStreetViewUrl(config: GoogleStreetViewPluginConfig, location: GoogleStreetViewLocation): string {
  const url = new URL("https://maps.googleapis.com/maps/api/streetview");
  url.searchParams.set("size", config.imageSize);
  url.searchParams.set("location", formatLocation(location));
  url.searchParams.set("heading", String(config.heading));
  url.searchParams.set("pitch", String(config.pitch));
  url.searchParams.set("fov", String(config.fov));
  url.searchParams.set("key", config.apiKey ?? "");
  return url.toString();
}

export async function createStreetViewMapTilesSession(input: {
  config: GoogleStreetViewPluginConfig;
  fetchImpl: typeof fetch;
}): Promise<GoogleStreetViewMapTilesSession> {
  assertApiKey(input.config);
  const response = await input.fetchImpl(mapTilesSessionUrl(input.config), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mapType: "streetview",
      language: "en-US",
      region: "US"
    })
  });
  if (!response.ok) throw new Error(`google streetview map tiles session request failed: HTTP ${response.status} ${response.statusText}`);
  const body = await response.json() as { session?: unknown; expiry?: unknown };
  const token = typeof body.session === "string" && body.session.trim() ? body.session.trim() : undefined;
  const expirySeconds = typeof body.expiry === "string" || typeof body.expiry === "number" ? Number(body.expiry) : Number.NaN;
  if (!token || !Number.isFinite(expirySeconds)) throw new Error("google streetview map tiles session response was invalid");
  return {
    token,
    expiryMs: expirySeconds * 1000,
    apiKey: input.config.apiKey
  };
}

export async function getPanoGraphByCoordinates(input: {
  config: GoogleStreetViewPluginConfig;
  sessionToken: string;
  requestedLocation: GoogleStreetViewLocation;
  radiusMeters?: number;
  fetchImpl: typeof fetch;
}): Promise<GoogleStreetViewPanoGraphResult> {
  const metadata = await getMapTilesPanoMetadata({
    config: input.config,
    sessionToken: input.sessionToken,
    searchParams: {
      lat: String(input.requestedLocation.lat),
      lng: String(input.requestedLocation.lng),
      radius: String(input.radiusMeters ?? input.config.initialRadiusMeters)
    },
    fetchImpl: input.fetchImpl
  });
  return normalizePanoGraphMetadata(metadata, input.requestedLocation);
}

export async function getPanoGraphByPanoId(input: {
  config: GoogleStreetViewPluginConfig;
  sessionToken: string;
  panoId: string;
  fetchImpl: typeof fetch;
}): Promise<GoogleStreetViewPanoGraphResult> {
  const metadata = await getMapTilesPanoMetadata({
    config: input.config,
    sessionToken: input.sessionToken,
    searchParams: { panoId: input.panoId },
    fetchImpl: input.fetchImpl
  });
  return normalizePanoGraphMetadata(metadata);
}

function metadataUrl(config: GoogleStreetViewPluginConfig, location: GoogleStreetViewLocation, radius: number): string {
  const url = new URL("https://maps.googleapis.com/maps/api/streetview/metadata");
  url.searchParams.set("location", formatLocation(location));
  url.searchParams.set("radius", String(radius));
  url.searchParams.set("key", config.apiKey ?? "");
  return url.toString();
}

async function getMapTilesPanoMetadata(input: {
  config: GoogleStreetViewPluginConfig;
  sessionToken: string;
  searchParams: Record<string, string>;
  fetchImpl: typeof fetch;
}): Promise<GoogleStreetViewPanoGraphMetadataResponse> {
  assertApiKey(input.config);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await input.fetchImpl(mapTilesStreetViewMetadataUrl(input.config, input.sessionToken, input.searchParams));
      if (!response.ok) throw new Error(`google streetview map tiles metadata request failed: HTTP ${response.status} ${response.statusText}`);
      const metadata = await response.json() as GoogleStreetViewPanoGraphMetadataResponse;
      if (metadata && typeof metadata === "object" && "error" in metadata) {
        const error = metadata.error;
        const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
          ? error.message
          : "unknown error";
        throw new Error(`google streetview map tiles metadata request failed: ${message}`);
      }
      return metadata;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function normalizePanoGraphMetadata(
  metadata: GoogleStreetViewPanoGraphMetadataResponse,
  fallbackLocation?: GoogleStreetViewLocation
): GoogleStreetViewPanoGraphResult {
  const panoId = typeof metadata.panoId === "string" && metadata.panoId.trim() ? metadata.panoId.trim() : undefined;
  if (!panoId) throw new Error("google streetview map tiles metadata returned no panoId");
  const location = normalizeLocation({
    lat: typeof metadata.lat === "number" ? metadata.lat : fallbackLocation?.lat,
    lng: typeof metadata.lng === "number" ? metadata.lng : fallbackLocation?.lng
  });
  const heading = normalizeHeading(typeof metadata.heading === "number" && Number.isFinite(metadata.heading) ? metadata.heading : 0);
  return {
    panoId,
    location,
    heading,
    links: Array.isArray(metadata.links) ? metadata.links.map(normalizePanoGraphLink).filter((link): link is NonNullable<ReturnType<typeof normalizePanoGraphLink>> => Boolean(link)) : [],
    metadata
  };
}

function normalizePanoGraphLink(value: unknown): { panoId: string; heading: number; text?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const link = value as { panoId?: unknown; heading?: unknown; text?: unknown };
  const panoId = typeof link.panoId === "string" && link.panoId.trim() ? link.panoId.trim() : undefined;
  const heading = typeof link.heading === "number" && Number.isFinite(link.heading) ? link.heading : undefined;
  if (!panoId || heading === undefined) return undefined;
  return {
    panoId,
    heading: normalizeHeading(heading),
    text: typeof link.text === "string" && link.text.trim() ? link.text.trim() : undefined
  };
}

function mapTilesSessionUrl(config: GoogleStreetViewPluginConfig): string {
  const url = new URL("https://tile.googleapis.com/v1/createSession");
  url.searchParams.set("key", config.apiKey ?? "");
  return url.toString();
}

function mapTilesStreetViewMetadataUrl(config: GoogleStreetViewPluginConfig, sessionToken: string, searchParams: Record<string, string>): string {
  const url = new URL("https://tile.googleapis.com/v1/streetview/metadata");
  url.searchParams.set("session", sessionToken);
  url.searchParams.set("key", config.apiKey ?? "");
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
  return url.toString();
}

function assertApiKey(config: GoogleStreetViewPluginConfig): void {
  if (!config.apiKey) throw new Error("google streetview API key is not configured");
}

function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}
