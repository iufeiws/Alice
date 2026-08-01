const fs = await import("node:fs");
const path = await import("node:path");

import type {
  GoogleStreetViewLocation,
  GoogleStreetViewImageRecognition,
  GoogleStreetViewMetadataResponse,
  GoogleStreetViewPanoGraphMetadataResponse,
  GoogleStreetViewPluginConfig,
  GoogleStreetViewPluginDeps,
  GoogleStreetViewResult
} from "./types.js";
import { findAvailableMetadata, staticStreetViewUrl } from "./client.js";
import { normalizeLocation, normalizeMetadataLocation } from "./geo.js";
import { parseJsonObject, safeFilePart } from "./internal.js";

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
  const actualLocation = normalizeMetadataLocation(metadata, input.requestedLocation);
  storeStreetViewMetadata(input.config, metadata);
  const panoId = panoIdFromMetadata(metadata);
  if (!panoId) throw new Error("google streetview metadata returned no pano_id");
  const stored = pickStoredResultByPanoId(input.config, panoId);
  if (stored) {
    input.appendLog?.("info", `google streetview pano reuse hit: pano=${panoId} asset=${stored.assetId}`);
    return stored;
  }

  const outputDir = path.resolve(input.config.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const fileBase = fileBaseForPanoId(panoId);
  const filePath = path.join(outputDir, `${fileBase}.jpg`);
  const imageUrl = staticStreetViewUrl(input.config, actualLocation);
  const imageResponse = await input.fetchImpl(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`google streetview image request failed: HTTP ${imageResponse.status} ${imageResponse.statusText}`);
  }
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (!bytes.length) throw new Error("google streetview image request returned empty body");
  fs.writeFileSync(filePath, bytes);

  input.appendLog?.("info", `google streetview saved: asset=${assetIdForPath(filePath)} bucket=${input.coordinateBucket}`);
  return metadataToResult({
    config: input.config,
    filePath,
    metadataPath: metadataPathForPanoId(input.config, panoId),
    metadata,
    requestedLocation: input.requestedLocation,
    location: actualLocation,
    coordinateBucket: input.coordinateBucket,
    regionId: input.regionId,
    reused: false
  });
}

export function storeStreetViewMetadata(config: GoogleStreetViewPluginConfig, metadata: GoogleStreetViewMetadataResponse | GoogleStreetViewPanoGraphMetadataResponse): void {
  const panoId = metadataPanoId(metadata);
  if (!panoId) throw new Error("google streetview metadata returned no panoId");
  const metadataPath = metadataPathForPanoId(config, panoId);
  const existing = fs.existsSync(metadataPath)
    ? parseJsonObject(fs.readFileSync(metadataPath, "utf8"))
    : undefined;
  if (existing && typeof (metadata as GoogleStreetViewMetadataResponse).pano_id === "string") {
    if (existing.panoId === panoId) return;
  }
  const imageRecognition = imageRecognitionValue(existing?.imageRecognition);
  const storedMetadata = imageRecognition ? { ...metadata, imageRecognition } : metadata;
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(storedMetadata, null, 2)}\n`);
}

export function readStreetViewImageRecognitionCache(metadataPath: string): GoogleStreetViewImageRecognition | undefined {
  if (!fs.existsSync(metadataPath)) return undefined;
  return imageRecognitionValue(parseJsonObject(fs.readFileSync(metadataPath, "utf8")).imageRecognition);
}

export function storeStreetViewImageRecognitionCache(metadataPath: string, recognition: GoogleStreetViewImageRecognition): void {
  if (!fs.existsSync(metadataPath)) throw new Error("google streetview metadata cache is missing");
  const metadata = parseJsonObject(fs.readFileSync(metadataPath, "utf8"));
  fs.writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, imageRecognition: recognition }, null, 2)}\n`);
}

export function readPanoGraphMetadataCache(config: GoogleStreetViewPluginConfig, panoId: string): GoogleStreetViewPanoGraphMetadataResponse | undefined {
  const metadataPath = metadataPathForPanoId(config, panoId);
  if (!fs.existsSync(metadataPath)) return undefined;
  const metadata = parseJsonObject(fs.readFileSync(metadataPath, "utf8"));
  return metadata.panoId === panoId
    ? metadata as GoogleStreetViewPanoGraphMetadataResponse
    : undefined;
}

function pickStoredResultByPanoId(config: GoogleStreetViewPluginConfig, panoId: string): GoogleStreetViewResult | undefined {
  const root = path.resolve(config.outputDir);
  const fileBase = fileBaseForPanoId(panoId);
  const filePath = path.join(root, `${fileBase}.jpg`);
  const metadataPath = metadataPathForPanoId(config, panoId);
  if (!fs.existsSync(filePath) || !fs.existsSync(metadataPath)) return undefined;
  const metadata = parseJsonObject(fs.readFileSync(metadataPath, "utf8")) as GoogleStreetViewMetadataResponse | GoogleStreetViewPanoGraphMetadataResponse;
  if (metadataPanoId(metadata) !== panoId) return undefined;
  const location = locationFromMetadata(metadata, { lat: 0, lng: 0 });
  return metadataToResult({
    config,
    filePath,
    metadataPath,
    metadata,
    requestedLocation: location,
    location,
    coordinateBucket: "",
    reused: true
  });
}

function panoIdFromMetadata(metadata: GoogleStreetViewMetadataResponse): string | undefined {
  return typeof metadata.pano_id === "string" && metadata.pano_id.trim() ? metadata.pano_id.trim() : undefined;
}

function metadataPanoId(metadata: GoogleStreetViewMetadataResponse | GoogleStreetViewPanoGraphMetadataResponse): string | undefined {
  return typeof metadata.panoId === "string" && metadata.panoId.trim()
    ? metadata.panoId.trim()
    : panoIdFromMetadata(metadata as GoogleStreetViewMetadataResponse);
}

function metadataPathForPanoId(config: GoogleStreetViewPluginConfig, panoId: string): string {
  return path.join(path.resolve(config.outputDir), `${fileBaseForPanoId(panoId)}.json`);
}

function fileBaseForPanoId(panoId: string): string {
  const fileBase = safeFilePart(panoId);
  if (!fileBase) throw new Error("google streetview pano_id cannot be used as file name");
  return fileBase;
}

function locationFromMetadata(metadata: GoogleStreetViewMetadataResponse | GoogleStreetViewPanoGraphMetadataResponse, fallback: GoogleStreetViewLocation): GoogleStreetViewLocation {
  if (typeof metadata.lat === "number" && typeof metadata.lng === "number") return normalizeLocation({ lat: metadata.lat, lng: metadata.lng });
  return normalizeMetadataLocation(metadata as GoogleStreetViewMetadataResponse, fallback);
}

function metadataToResult(input: {
  config: GoogleStreetViewPluginConfig;
  filePath: string;
  metadataPath: string;
  metadata: GoogleStreetViewMetadataResponse | GoogleStreetViewPanoGraphMetadataResponse;
  requestedLocation: GoogleStreetViewLocation;
  location: GoogleStreetViewLocation;
  coordinateBucket: string;
  regionId?: string;
  reused: boolean;
}): GoogleStreetViewResult {
  const panoId = metadataPanoId(input.metadata);
  if (!panoId) throw new Error("google streetview metadata returned no panoId");
  return {
    assetId: assetIdForPath(input.filePath),
    filePath: input.filePath,
    metadataPath: input.metadataPath,
    location: input.location,
    requestedLocation: input.requestedLocation,
    coordinateBucket: input.coordinateBucket,
    regionId: input.regionId,
    panoId,
    heading: input.config.heading,
    pitch: input.config.pitch,
    fov: input.config.fov,
    source: input.reused ? "stored" : "google_streetview_static",
    reused: input.reused,
    metadata: input.metadata
  };
}

function assetIdForPath(filePath: string): string {
  const relative = path.relative(path.resolve("assets"), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("google streetview asset path is outside assets");
  return relative.split(path.sep).join("/");
}

function imageRecognitionValue(value: unknown): GoogleStreetViewImageRecognition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const recognition = value as Record<string, unknown>;
  if (typeof recognition.text !== "string" || !recognition.text.trim()) return undefined;
  if (recognition.provider !== "multimodal_llm") return undefined;
  return {
    text: recognition.text,
    provider: recognition.provider,
    model: typeof recognition.model === "string" ? recognition.model : undefined,
    durationMs: typeof recognition.durationMs === "number" ? recognition.durationMs : undefined,
    requestId: typeof recognition.requestId === "string" ? recognition.requestId : undefined
  };
}
