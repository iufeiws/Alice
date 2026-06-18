const fs = await import("node:fs");
const path = await import("node:path");

import type {
  GoogleStreetViewLocation,
  GoogleStreetViewMetadataResponse,
  GoogleStreetViewPluginConfig,
  GoogleStreetViewPluginDeps,
  GoogleStreetViewResult,
  GoogleStreetViewSidecar
} from "./types.js";
import { findAvailableMetadata, staticStreetViewUrl } from "./client.js";
import { normalizeLocation, normalizeMetadataLocation } from "./geo.js";
import { numberValue, parseJsonObject, safeFilePart } from "./internal.js";

export async function fetchAndStoreStreetView(input: {
  config: GoogleStreetViewPluginConfig;
  requestedLocation: GoogleStreetViewLocation;
  regionId?: string;
  coordinateBucket: string;
  fetchImpl: typeof fetch;
  now(): Date;
  appendLog?: GoogleStreetViewPluginDeps["appendLog"];
}): Promise<GoogleStreetViewResult> {
  if (!input.config.apiKey) throw new Error("google streetview API key is not configured");
  const metadata = await findAvailableMetadata(input);
  const panoId = panoIdFromMetadata(metadata);
  if (!panoId) throw new Error("google streetview metadata returned no pano_id");
  const stored = pickStoredResultByPanoId(input.config, panoId);
  if (stored) {
    input.appendLog?.("info", `google streetview pano reuse hit: pano=${panoId} asset=${stored.assetId}`);
    return stored;
  }

  const actualLocation = normalizeMetadataLocation(metadata, input.requestedLocation);
  const now = input.now();
  const outputDir = path.resolve(input.config.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const fileBase = fileBaseForPanoId(panoId);
  const filePath = path.join(outputDir, `${fileBase}.jpg`);
  const sidecarPath = path.join(outputDir, `${fileBase}.json`);
  const imageUrl = staticStreetViewUrl(input.config, actualLocation);
  const imageResponse = await input.fetchImpl(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`google streetview image request failed: HTTP ${imageResponse.status} ${imageResponse.statusText}`);
  }
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (!bytes.length) throw new Error("google streetview image request returned empty body");
  fs.writeFileSync(filePath, bytes);

  const assetId = assetIdForPath(filePath);
  const sidecar: GoogleStreetViewSidecar = {
    assetId,
    filePath,
    sidecarPath,
    coordinateBucket: input.coordinateBucket,
    requestedLocation: input.requestedLocation,
    location: actualLocation,
    regionId: input.regionId,
    panoId,
    heading: input.config.heading,
    pitch: input.config.pitch,
    fov: input.config.fov,
    metadata,
    createdAt: now.toISOString()
  };
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  input.appendLog?.("info", `google streetview saved: asset=${assetId} bucket=${input.coordinateBucket}`);
  return sidecarToResult(sidecar, false);
}

function pickStoredResultByPanoId(config: GoogleStreetViewPluginConfig, panoId: string): GoogleStreetViewResult | undefined {
  const root = path.resolve(config.outputDir);
  const fileBase = fileBaseForPanoId(panoId);
  const filePath = path.join(root, `${fileBase}.jpg`);
  const sidecarPath = path.join(root, `${fileBase}.json`);
  if (!fs.existsSync(filePath) || !fs.existsSync(sidecarPath)) return undefined;
  try {
    const parsed = parseJsonObject(fs.readFileSync(sidecarPath, "utf8")) as Partial<GoogleStreetViewSidecar>;
    const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata as GoogleStreetViewMetadataResponse : {};
    const storedPanoId = typeof parsed.panoId === "string" ? parsed.panoId : panoIdFromMetadata(metadata) ?? panoId;
    if (storedPanoId !== panoId) return undefined;
    return sidecarToResult({
      assetId: typeof parsed.assetId === "string" ? parsed.assetId : assetIdForPath(filePath),
      filePath,
      sidecarPath,
      coordinateBucket: typeof parsed.coordinateBucket === "string" ? parsed.coordinateBucket : "",
      requestedLocation: normalizeLocation(parsed.requestedLocation),
      location: normalizeLocation(parsed.location),
      regionId: typeof parsed.regionId === "string" ? parsed.regionId : undefined,
      panoId: storedPanoId,
      heading: numberValue(parsed.heading, 0),
      pitch: numberValue(parsed.pitch, 0),
      fov: numberValue(parsed.fov, 90),
      metadata,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
    }, true);
  } catch {
    return undefined;
  }
}

function panoIdFromMetadata(metadata: GoogleStreetViewMetadataResponse): string | undefined {
  return typeof metadata.pano_id === "string" && metadata.pano_id.trim() ? metadata.pano_id.trim() : undefined;
}

function fileBaseForPanoId(panoId: string): string {
  const fileBase = safeFilePart(panoId);
  if (!fileBase) throw new Error("google streetview pano_id cannot be used as file name");
  return fileBase;
}

function sidecarToResult(sidecar: GoogleStreetViewSidecar, reused: boolean): GoogleStreetViewResult {
  return {
    assetId: sidecar.assetId,
    filePath: sidecar.filePath,
    sidecarPath: sidecar.sidecarPath ?? sidecar.filePath.replace(/\.[^.]+$/, ".json"),
    location: sidecar.location,
    requestedLocation: sidecar.requestedLocation,
    coordinateBucket: sidecar.coordinateBucket,
    regionId: sidecar.regionId,
    panoId: sidecar.panoId,
    heading: sidecar.heading,
    pitch: sidecar.pitch,
    fov: sidecar.fov,
    source: reused ? "stored" : "google_streetview_static",
    reused,
    metadata: sidecar.metadata
  };
}

function assetIdForPath(filePath: string): string {
  const relative = path.relative(path.resolve("assets"), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("google streetview asset path is outside assets");
  return relative.split(path.sep).join("/");
}
