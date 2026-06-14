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
import { formatFileDateTime, numberValue, parseJsonObject, safeFilePart } from "./internal.js";

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
  const now = input.now();
  const month = now.toISOString().slice(0, 7);
  const outputDir = path.resolve(input.config.outputDir, month);
  fs.mkdirSync(outputDir, { recursive: true });
  const fileBase = `${safeFilePart(input.coordinateBucket)}_${formatFileDateTime(now.toISOString())}`;
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
    panoId: typeof metadata.pano_id === "string" ? metadata.pano_id : undefined,
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

export function pickStoredResult(config: GoogleStreetViewPluginConfig, coordinateBucket: string, random: () => number): GoogleStreetViewResult | undefined {
  const sidecars = listStoredSidecars(config.outputDir)
    .filter((entry) => entry.coordinateBucket === coordinateBucket && fs.existsSync(entry.filePath));
  if (!sidecars.length) return undefined;
  return sidecarToResult(sidecars[Math.floor(random() * sidecars.length)]!, true);
}

function listStoredSidecars(outputDir: string): GoogleStreetViewSidecar[] {
  const root = path.resolve(outputDir);
  if (!fs.existsSync(root)) return [];
  const entries: GoogleStreetViewSidecar[] = [];
  for (const filePath of walkFiles(root)) {
    if (!filePath.endsWith(".json")) continue;
    try {
      const parsed = parseJsonObject(fs.readFileSync(filePath, "utf8")) as Partial<GoogleStreetViewSidecar>;
      if (typeof parsed.assetId !== "string" || typeof parsed.filePath !== "string" || typeof parsed.coordinateBucket !== "string") continue;
      entries.push({
        assetId: parsed.assetId,
        filePath: parsed.filePath,
        sidecarPath: filePath,
        coordinateBucket: parsed.coordinateBucket,
        requestedLocation: normalizeLocation(parsed.requestedLocation),
        location: normalizeLocation(parsed.location),
        regionId: typeof parsed.regionId === "string" ? parsed.regionId : undefined,
        panoId: typeof parsed.panoId === "string" ? parsed.panoId : undefined,
        heading: numberValue(parsed.heading, 0),
        pitch: numberValue(parsed.pitch, 0),
        fov: numberValue(parsed.fov, 90),
        metadata: parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata as GoogleStreetViewMetadataResponse : {},
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
      });
    } catch {
      continue;
    }
  }
  return entries;
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

function* walkFiles(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}
