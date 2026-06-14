import type {
  GoogleStreetViewLocation,
  GoogleStreetViewMetadataResponse,
  GoogleStreetViewPluginConfig
} from "./types.js";
import { formatLocation } from "./geo.js";

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

function metadataUrl(config: GoogleStreetViewPluginConfig, location: GoogleStreetViewLocation, radius: number): string {
  const url = new URL("https://maps.googleapis.com/maps/api/streetview/metadata");
  url.searchParams.set("location", formatLocation(location));
  url.searchParams.set("radius", String(radius));
  url.searchParams.set("key", config.apiKey ?? "");
  return url.toString();
}
