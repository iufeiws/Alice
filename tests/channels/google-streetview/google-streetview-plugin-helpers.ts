import { after } from "node:test";
import type { GoogleStreetViewLocation, GoogleStreetViewPluginConfig } from "../../../src/channels/google-streetview/src/index.js";

export const fs = await import("node:fs");
export const os = await import("node:os");
export const path = await import("node:path");

const tempRoots: string[] = [];
const originalCwd = process.cwd();

after(() => {
  process.chdir(originalCwd);
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

export function configWithOutput(outputDir: string): GoogleStreetViewPluginConfig {
  return {
    enabled: true,
    apiKey: "secret",
    imageSize: "640x640",
    heading: 0,
    pitch: 0,
    fov: 90,
    initialRadiusMeters: 50,
    radiusExpansionFactor: 2,
    maxRadiusMeters: 1000,
    randomAttempts: 8,
    coordinatePrecision: 5,
    outputDir,
    regions: []
  };
}

export function tempOutputRoot(): string {
  const projectRoot = fs.mkdtempSync(path.join(aliceTestsRoot(), "google-streetview-"));
  tempRoots.push(projectRoot);
  process.chdir(projectRoot);
  const parent = path.join(projectRoot, "assets", "plugin", "google-streetview");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "test-"));
  return dir;
}

export function missingConfigPath(): string {
  const root = fs.mkdtempSync(path.join(aliceTestsRoot(), "alice-google-streetview-config-"));
  tempRoots.push(root);
  return path.join(root, "missing.json");
}

export function writeStoredResult(
  root: string,
  name: string,
  panoId: string,
  location: GoogleStreetViewLocation = { lat: 35, lng: 139 }
): { assetId: string } {
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, Buffer.from([1]));
  const assetId = path.relative(path.resolve("assets"), path.resolve(filePath)).split(path.sep).join("/");
  fs.writeFileSync(filePath.replace(/\.jpg$/, ".json"), `${JSON.stringify({ status: "OK", pano_id: panoId, location })}\n`);
  return { assetId };
}

export function storedMetadata(root: string, panoId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, `${panoId}.json`), "utf8")) as Record<string, unknown>;
}

export function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

export function bytesResponse(value: Uint8Array): Response {
  const body = new ArrayBuffer(value.byteLength);
  new Uint8Array(body).set(value);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "image/jpeg" }
  });
}

export function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function aliceTestsRoot(): string {
  const root = path.join(os.tmpdir(), "alice-tests");
  fs.mkdirSync(root, { recursive: true });
  return root;
}
