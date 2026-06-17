import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketForLocation,
  createGoogleStreetViewPlugin,
  publicGoogleStreetViewPluginConfig,
  readGoogleStreetViewPluginConfig,
  validateGoogleStreetViewPluginConfig,
  type GoogleStreetViewPluginConfig
} from "../src/channels/google-streetview/src/index.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("google streetview config reads env API key and hides it in public config", () => {
  const config = readGoogleStreetViewPluginConfig(missingConfigPath(), {}, { GOOGLE_STREETVIEW_API_KEY: "secret" });
  assert.equal(config.apiKey, "secret");
  assert.equal(config.outputDir, "assets/plugin/google-streetview");

  const publicConfig = publicGoogleStreetViewPluginConfig(config);
  assert.equal(publicConfig.apiKeySet, true);
  assert.equal("apiKey" in publicConfig, false);
});

test("google streetview fetches metadata, saves image, and writes sidecar", async () => {
  const root = tempOutputRoot();
  const requests: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    now: () => new Date("2026-06-14T01:02:03.000Z"),
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/metadata")) {
        return jsonResponse({
          status: "OK",
          pano_id: "pano-1",
          location: { lat: 35.1, lng: 139.1 }
        });
      }
      return bytesResponse(new Uint8Array([1, 2, 3, 4]));
    }
  });

  const result = await plugin.getStreetViewByCoordinates({ lat: 35, lng: 139, regionId: "tokyo" });

  assert.equal(result.reused, false);
  assert.equal(result.source, "google_streetview_static");
  assert.match(result.assetId, /^plugin\/google-streetview\/test-[^/]+\/2026-06\//);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(fs.existsSync(result.sidecarPath), true);
  assert.equal(result.panoId, "pano-1");
  assert.equal(result.location.lat, 35.1);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0]!).searchParams.get("radius"), "50");
});

test("google streetview metadata lookup does not download image", async () => {
  const root = tempOutputRoot();
  const requests: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    fetch: async (url) => {
      requests.push(String(url));
      return jsonResponse({
        status: "OK",
        pano_id: "pano-meta",
        location: { lat: 41.01, lng: 28.98 }
      });
    }
  });

  const result = await plugin.getMetadataByCoordinates({ lat: 41, lng: 29 });

  assert.equal(result.panoId, "pano-meta");
  assert.equal(result.location.lat, 41.01);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.includes("/metadata"), true);
});

test("google streetview pano graph creates and reuses map tiles session", async () => {
  const root = tempOutputRoot();
  let nowMs = Date.parse("2026-06-17T00:00:00.000Z");
  let sessionCalls = 0;
  const metadataRequests: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    now: () => new Date(nowMs),
    fetch: async (url, init) => {
      const text = String(url);
      if (text.includes("/createSession")) {
        sessionCalls += 1;
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          mapType: "streetview",
          language: "en-US",
          region: "US"
        });
        return jsonResponse({
          session: `session-${sessionCalls}`,
          expiry: String((nowMs + 120_000) / 1000)
        });
      }
      metadataRequests.push(text);
      return jsonResponse({
        panoId: text.includes("panoId=pano-2") ? "pano-2" : "pano-1",
        lat: 35.1,
        lng: 139.1,
        heading: 94.5,
        links: [{ panoId: "pano-2", heading: 90, text: "Main St" }]
      });
    }
  });

  const byCoordinates = await plugin.getPanoGraphByCoordinates({ lat: 35, lng: 139 });
  nowMs += 30_000;
  const byPanoId = await plugin.getPanoGraphByPanoId({ panoId: "pano-2" });

  assert.equal(sessionCalls, 1);
  assert.equal(byCoordinates.panoId, "pano-1");
  assert.equal(byCoordinates.location.lat, 35.1);
  assert.equal(byCoordinates.heading, 94.5);
  assert.deepEqual(byCoordinates.links, [{ panoId: "pano-2", heading: 90, text: "Main St" }]);
  assert.equal(byPanoId.panoId, "pano-2");
  assert.equal(new URL(metadataRequests[0]!).searchParams.get("session"), "session-1");
  assert.equal(new URL(metadataRequests[0]!).searchParams.get("lat"), "35");
  assert.equal(new URL(metadataRequests[0]!).searchParams.get("lng"), "139");
  assert.equal(new URL(metadataRequests[0]!).searchParams.get("radius"), "50");
  assert.equal(new URL(metadataRequests[1]!).searchParams.get("panoId"), "pano-2");
});

test("google streetview pano graph refreshes expired map tiles session", async () => {
  const root = tempOutputRoot();
  let nowMs = Date.parse("2026-06-17T00:00:00.000Z");
  let sessionCalls = 0;
  const metadataSessions: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    now: () => new Date(nowMs),
    fetch: async (url) => {
      const text = String(url);
      if (text.includes("/createSession")) {
        sessionCalls += 1;
        return jsonResponse({
          session: `session-${sessionCalls}`,
          expiry: String((nowMs + 120_000) / 1000)
        });
      }
      metadataSessions.push(new URL(text).searchParams.get("session") ?? "");
      return jsonResponse({ panoId: `pano-${metadataSessions.length}`, lat: 35, lng: 139, heading: 0, links: [] });
    }
  });

  await plugin.getPanoGraphByCoordinates({ lat: 35, lng: 139 });
  nowMs += 30_000;
  await plugin.getPanoGraphByPanoId({ panoId: "pano-1" });
  nowMs += 91_000;
  await plugin.getPanoGraphByPanoId({ panoId: "pano-2" });

  assert.equal(sessionCalls, 2);
  assert.deepEqual(metadataSessions, ["session-1", "session-1", "session-2"]);
});

test("google streetview pano graph surfaces map tiles API errors", async () => {
  const root = tempOutputRoot();
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    fetch: async (url) => {
      const text = String(url);
      if (text.includes("/createSession")) return jsonResponse({ session: "session-1", expiry: "1780000000" });
      return new Response(JSON.stringify({ error: { message: "bad session" } }), {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" }
      });
    }
  });

  await assert.rejects(
    () => plugin.getPanoGraphByCoordinates({ lat: 35, lng: 139 }),
    /map tiles metadata request failed: HTTP 400 Bad Request/
  );
});

test("reuseStoredForLocation returns a stored result without calling Google", async () => {
  const root = tempOutputRoot();
  const bucket = bucketForLocation({ lat: 35, lng: 139 }, 5);
  const stored = writeStoredResult(root, bucket, "stored-a.jpg");
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    random: () => 0,
    fetch: async () => {
      throw new Error("fetch should not be called");
    }
  });

  const result = await plugin.getStreetViewByCoordinates({ lat: 35, lng: 139, reuseStoredForLocation: true });

  assert.equal(result.reused, true);
  assert.equal(result.source, "stored");
  assert.equal(result.assetId, stored.assetId);
});

test("stored reuse is isolated by coordinate bucket", async () => {
  const root = tempOutputRoot();
  writeStoredResult(root, bucketForLocation({ lat: 35, lng: 139 }, 5), "stored-a.jpg");
  let metadataCalls = 0;
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    now: () => new Date("2026-06-14T01:02:03.000Z"),
    fetch: async (url) => {
      if (String(url).includes("/metadata")) {
        metadataCalls += 1;
        return jsonResponse({ status: "OK", location: { lat: 36, lng: 140 } });
      }
      return bytesResponse(new Uint8Array([9]));
    }
  });

  const result = await plugin.getStreetViewByCoordinates({ lat: 36, lng: 140, reuseStoredForLocation: true });

  assert.equal(result.reused, false);
  assert.equal(metadataCalls, 1);
});

test("metadata lookup expands radius until max radius", async () => {
  const root = tempOutputRoot();
  const radii: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: {
      ...configWithOutput(root),
      initialRadiusMeters: 10,
      radiusExpansionFactor: 2,
      maxRadiusMeters: 40
    },
    fetch: async (url) => {
      const parsed = new URL(String(url));
      radii.push(parsed.searchParams.get("radius") ?? "");
      return jsonResponse({ status: "ZERO_RESULTS" });
    }
  });

  await assert.rejects(
    () => plugin.getStreetViewByCoordinates({ lat: 35, lng: 139 }),
    /no imagery/
  );
  assert.deepEqual(radii, ["10", "20", "40"]);
});

test("random streetview samples configured region and retries failed candidates", async () => {
  const root = tempOutputRoot();
  let metadataCalls = 0;
  const plugin = createGoogleStreetViewPlugin({
    config: {
      ...configWithOutput(root),
      randomAttempts: 2,
      maxRadiusMeters: 50,
      regions: [{
        id: "tokyo",
        bounds: { north: 36, south: 35, east: 140, west: 139 }
      }]
    },
    random: sequenceRandom([0, 0.5, 0.5, 0, 0.6, 0.6]),
    now: () => new Date("2026-06-14T01:02:03.000Z"),
    fetch: async (url) => {
      if (String(url).includes("/metadata")) {
        metadataCalls += 1;
        const parsed = new URL(String(url));
        const [lat, lng] = parsed.searchParams.get("location")!.split(",").map(Number);
        assert.ok(lat! >= 35 && lat! <= 36);
        assert.ok(lng! >= 139 && lng! <= 140);
        return jsonResponse(metadataCalls === 1
          ? { status: "ZERO_RESULTS" }
          : { status: "OK", location: { lat, lng } });
      }
      return bytesResponse(new Uint8Array([7]));
    }
  });

  const result = await plugin.getRandomStreetView({ regionId: "tokyo" });

  assert.equal(result.reused, false);
  assert.equal(result.regionId, "tokyo");
  assert.equal(metadataCalls, 2);
});

test("google streetview output dir rejects generated and outside paths", () => {
  assert.equal(validateGoogleStreetViewPluginConfig(configWithOutput("assets/generated/streetview")), "invalid_output_dir");
  assert.equal(validateGoogleStreetViewPluginConfig(configWithOutput("/tmp/google-streetview")), "invalid_output_dir");
  assert.equal(validateGoogleStreetViewPluginConfig(configWithOutput("assets/plugin/google-streetview/cache")), undefined);
});

function configWithOutput(outputDir: string): GoogleStreetViewPluginConfig {
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

function writeStoredResult(root: string, coordinateBucket: string, name: string): { assetId: string } {
  const dir = path.join(root, "2026-06");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from([1]));
  const assetId = path.relative(path.resolve("assets"), path.resolve(filePath)).split(path.sep).join("/");
  fs.writeFileSync(filePath.replace(/\.jpg$/, ".json"), `${JSON.stringify({
    assetId,
    filePath,
    coordinateBucket,
    requestedLocation: { lat: 35, lng: 139 },
    location: { lat: 35, lng: 139 },
    heading: 0,
    pitch: 0,
    fov: 90,
    metadata: { status: "OK" },
    createdAt: "2026-06-14T01:02:03.000Z"
  })}\n`);
  return { assetId };
}

function tempOutputRoot(): string {
  const parent = path.resolve("assets/plugin/google-streetview");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "test-"));
  tempRoots.push(dir);
  return dir;
}

function missingConfigPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "alice-google-streetview-config-")), "missing.json");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function bytesResponse(value: Uint8Array): Response {
  const body = new ArrayBuffer(value.byteLength);
  new Uint8Array(body).set(value);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "image/jpeg" }
  });
}

function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
