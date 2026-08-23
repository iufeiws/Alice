import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocationTools } from "../../../../src/capabilities/tools/location/src/index.js";
import {
  readWorldWandererConfig,
  readWorldWandererState,
  writeWorldWandererConfig,
  writeWorldWandererState
} from "../../../../src/contexts/world-wanderer/src/index.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const nowIso = "2026-08-11T12:00:00.000";

test("Panorama is listed only while world wanderer is enabled", () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => streetViewStub(),
    now: () => nowIso
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: false });
  assert.deepEqual(tools.listTools(), []);

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  assert.deepEqual(tools.listTools().map((tool) => tool.name), ["Panorama"]);
});

test("Panorama schema uses an action enum with optional coordinates", () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => streetViewStub(),
    now: () => nowIso
  });
  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });

  const inputSchema = tools.listTools()[0].inputSchema as {
    type: string;
    properties: Record<string, { type?: string; enum?: string[]; minimum?: number; maximum?: number }>;
    required: string[];
    additionalProperties: boolean;
    oneOf?: unknown;
  };
  assert.equal(inputSchema.type, "object");
  assert.equal(inputSchema.properties.action.type, "string");
  assert.deepEqual(inputSchema.properties.action.enum, ["current", "teleport", "navigation"]);
  assert.deepEqual(inputSchema.required, ["action"]);
  assert.equal(inputSchema.additionalProperties, false);
  assert.equal(inputSchema.properties.lat.type, "number");
  assert.equal(inputSchema.properties.lat.minimum, -90);
  assert.equal(inputSchema.properties.lat.maximum, 90);
  assert.equal(inputSchema.properties.lng.type, "number");
  assert.equal(inputSchema.properties.lng.minimum, -180);
  assert.equal(inputSchema.properties.lng.maximum, 180);
  assert.equal(inputSchema.oneOf, undefined);
});

test("check_location is treated as an unknown tool", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => streetViewStub(),
    now: () => nowIso
  });
  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });

  const result = await tools.execute({ id: "call_location", toolName: "check_location", input: {} });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Unknown location tool: check_location");
});

test("Panorama rejects invalid inputs with explicit errors", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => streetViewStub(),
    now: () => nowIso
  });
  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });

  const cases: Array<{ input: Record<string, unknown>; error: string }> = [
    { input: {}, error: "invalid_action" },
    { input: { action: "fly" }, error: "invalid_action" },
    { input: { action: "teleport" }, error: "missing_lat" },
    { input: { action: "teleport", lat: 40.7128 }, error: "missing_lng" },
    { input: { action: "navigation" }, error: "missing_lat" },
    { input: { action: "navigation", lat: 40.7128 }, error: "missing_lng" },
    { input: { action: "teleport", lat: "abc", lng: -74.006 }, error: "invalid_lat" },
    { input: { action: "teleport", lat: Number.NaN, lng: -74.006 }, error: "invalid_lat" },
    { input: { action: "teleport", lat: 91, lng: -74.006 }, error: "invalid_lat" },
    { input: { action: "teleport", lat: -91, lng: -74.006 }, error: "invalid_lat" },
    { input: { action: "teleport", lat: 40.7128, lng: 181 }, error: "invalid_lng" },
    { input: { action: "teleport", lat: 40.7128, lng: -181 }, error: "invalid_lng" },
    { input: { action: "navigation", lat: 40.7128, lng: "abc" }, error: "invalid_lng" }
  ];
  for (const entry of cases) {
    const result = await tools.execute({ id: "call_location", toolName: "Panorama", input: entry.input });
    assert.equal(result.ok, false, JSON.stringify(entry.input));
    assert.equal(result.error, entry.error, JSON.stringify(entry.input));
  }
});

test("Panorama is unavailable while world wanderer is disabled", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => streetViewStub(),
    now: () => nowIso
  });
  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: false });

  const result = await tools.execute({ id: "call_location", toolName: "Panorama", input: { action: "current" } });

  assert.equal(result.ok, false);
  assert.equal(result.error, "location_unavailable");
});

test("Panorama current returns readable place text and requests image recognition", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const streetViewInputs: Array<Record<string, unknown>> = [];
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        return locationPano();
      },
      async getPanoGraphByPanoId() {
        return locationPano();
      },
      async getStreetViewByCoordinates(input) {
        streetViewInputs.push(input);
        return recognizedStreetView();
      }
    }),
    now: () => nowIso
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  writeWorldWandererState(dbPath, {
    location: { lat: 41.0089, lng: 28.9804 },
    lastHeading: 90,
    panoId: "hidden-pano",
    pathStack: [{ time: "2026-06-18T00:00:00.000", panoId: "hidden-pano", lat: 41.0089, lng: 28.9804, lastHeading: 90 }]
  });

  const result = await tools.execute({ id: "call_location", toolName: "Panorama", input: { action: "current" } });

  assert.deepEqual(streetViewInputs, [{ lat: 41.0089, lng: 28.9804, recognizeImage: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.output, "Ayasofya Meydani, Istanbul, Turkiye\nRecord date: 2020-08\nA public square with a large historic building.");
  assert.equal(result.llmFollowupAttachments, undefined);
});

test("Panorama teleport queries the nearest pano by input coordinates", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const coordinateCalls: Array<Record<string, unknown>> = [];
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates(input) {
        coordinateCalls.push(input);
        return locationPano();
      },
      async getPanoGraphByPanoId() {
        throw new Error("unexpected getPanoGraphByPanoId call");
      },
      async getStreetViewByCoordinates() {
        throw new Error("unexpected getStreetViewByCoordinates call");
      }
    }),
    now: () => nowIso
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });

  const result = await tools.execute({
    id: "call_location",
    toolName: "Panorama",
    input: { action: "teleport", lat: 40.7128, lng: -74.006 }
  });

  assert.deepEqual(coordinateCalls, [{ lat: 40.7128, lng: -74.006 }]);
  assert.equal(result.ok, true);
  assert.equal(result.output, "Ayasofya Meydani, Istanbul, Turkiye\nRecord date: 2020-08");
});

test("Panorama teleport replaces the path with the pano location and heading", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        return locationPano();
      },
      async getPanoGraphByPanoId() {
        throw new Error("unexpected getPanoGraphByPanoId call");
      },
      async getStreetViewByCoordinates() {
        throw new Error("unexpected getStreetViewByCoordinates call");
      }
    }),
    now: () => nowIso
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  writeWorldWandererState(dbPath, {
    location: { lat: 1.1, lng: 2.2 },
    lastHeading: 0,
    panoId: "old-pano",
    pathStack: [{ time: "2026-01-01T00:00:00.000", panoId: "old-pano", lat: 1.1, lng: 2.2, lastHeading: 0 }]
  });

  const result = await tools.execute({
    id: "call_location",
    toolName: "Panorama",
    input: { action: "teleport", lat: 40.7128, lng: -74.006 }
  });

  assert.equal(result.ok, true);
  const state = readWorldWandererState(dbPath, readWorldWandererConfig(configPath));
  assert.equal(state.pathStack.length, 1);
  assert.deepEqual(state.location, { lat: 41.0089, lng: 28.9804 });
  assert.equal(state.panoId, "hidden-pano");
  assert.equal(state.lastHeading, 120);
  assert.deepEqual(state.pathStack, [{
    time: nowIso,
    panoId: "hidden-pano",
    lat: 41.0089,
    lng: 28.9804,
    lastHeading: 120
  }]);
});

test("Panorama teleport clears an existing navigation target", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        return locationPano();
      },
      async getPanoGraphByPanoId() {
        throw new Error("unexpected getPanoGraphByPanoId call");
      },
      async getStreetViewByCoordinates() {
        throw new Error("unexpected getStreetViewByCoordinates call");
      }
    }),
    now: () => nowIso
  });

  writeWorldWandererConfig(configPath, {
    ...baseConfig,
    enabled: true,
    targetLocation: { lat: 51.5074, lng: -0.1278 }
  });

  const result = await tools.execute({
    id: "call_location",
    toolName: "Panorama",
    input: { action: "teleport", lat: 40.7128, lng: -74.006 }
  });

  assert.equal(result.ok, true);
  const config = readWorldWandererConfig(configPath);
  assert.equal(config.targetLocation, undefined);
});

test("Panorama teleport without an address leaves state and config unchanged", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        return { ...locationPano(), metadata: {} };
      },
      async getPanoGraphByPanoId() {
        throw new Error("unexpected getPanoGraphByPanoId call");
      },
      async getStreetViewByCoordinates() {
        throw new Error("unexpected getStreetViewByCoordinates call");
      }
    }),
    now: () => nowIso
  });

  writeWorldWandererConfig(configPath, {
    ...baseConfig,
    enabled: true,
    targetLocation: { lat: 51.5074, lng: -0.1278 }
  });
  const originalState = {
    location: { lat: 1.1, lng: 2.2 },
    lastHeading: 0,
    panoId: "old-pano",
    pathStack: [{ time: "2026-01-01T00:00:00.000", panoId: "old-pano", lat: 1.1, lng: 2.2, lastHeading: 0 }]
  };
  writeWorldWandererState(dbPath, originalState);

  const result = await tools.execute({
    id: "call_location",
    toolName: "Panorama",
    input: { action: "teleport", lat: 40.7128, lng: -74.006 }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "location_address_unavailable");
  assert.deepEqual(readWorldWandererState(dbPath, readWorldWandererConfig(configPath)), originalState);
  const config = readWorldWandererConfig(configPath);
  assert.deepEqual(config.targetLocation, { lat: 51.5074, lng: -0.1278 });
});

test("Panorama teleport propagates street view query failures without persisting", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        throw new Error("street view unavailable");
      },
      async getPanoGraphByPanoId() {
        throw new Error("unexpected getPanoGraphByPanoId call");
      },
      async getStreetViewByCoordinates() {
        throw new Error("unexpected getStreetViewByCoordinates call");
      }
    }),
    now: () => nowIso
  });

  writeWorldWandererConfig(configPath, {
    ...baseConfig,
    enabled: true,
    targetLocation: { lat: 51.5074, lng: -0.1278 }
  });
  const originalState = {
    location: { lat: 1.1, lng: 2.2 },
    lastHeading: 0,
    panoId: "old-pano",
    pathStack: [{ time: "2026-01-01T00:00:00.000", panoId: "old-pano", lat: 1.1, lng: 2.2, lastHeading: 0 }]
  };
  writeWorldWandererState(dbPath, originalState);

  await assert.rejects(() => tools.execute({
    id: "call_location",
    toolName: "Panorama",
    input: { action: "teleport", lat: 40.7128, lng: -74.006 }
  }), /street view unavailable/);
  assert.deepEqual(readWorldWandererState(dbPath, readWorldWandererConfig(configPath)), originalState);
  assert.deepEqual(readWorldWandererConfig(configPath).targetLocation, { lat: 51.5074, lng: -0.1278 });
});

test("Panorama navigation stores the exact input as targetLocation without touching state", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const streetViewInputs: Array<Record<string, unknown>> = [];
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates(input) {
        streetViewInputs.push(input);
        throw new Error("unexpected getPanoGraphByCoordinates call");
      },
      async getPanoGraphByPanoId(input) {
        streetViewInputs.push(input);
        throw new Error("unexpected getPanoGraphByPanoId call");
      },
      async getStreetViewByCoordinates(input) {
        streetViewInputs.push(input);
        throw new Error("unexpected getStreetViewByCoordinates call");
      }
    }),
    now: () => nowIso
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  const originalState = {
    location: { lat: 41.0089, lng: 28.9804 },
    lastHeading: 90,
    panoId: "hidden-pano",
    pathStack: [{ time: "2026-06-18T00:00:00.000", panoId: "hidden-pano", lat: 41.0089, lng: 28.9804, lastHeading: 90 }]
  };
  writeWorldWandererState(dbPath, originalState);

  const result = await tools.execute({
    id: "call_location",
    toolName: "Panorama",
    input: { action: "navigation", lat: 48.8566, lng: 2.3522 }
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, JSON.stringify({ lat: 48.8566, lng: 2.3522 }));
  assert.deepEqual(streetViewInputs, []);
  assert.deepEqual(readWorldWandererConfig(configPath).targetLocation, { lat: 48.8566, lng: 2.3522 });
  assert.deepEqual(readWorldWandererState(dbPath, readWorldWandererConfig(configPath)), originalState);
});

function locationPano() {
  return {
    panoId: "hidden-pano",
    location: { lat: 41.0089, lng: 28.9804 },
    heading: 120,
    links: [],
    metadata: {
      formattedAddress: "Ayasofya Meydani, Istanbul, Turkiye",
      panoId: "hidden-pano",
      lat: 41.0089,
      lng: 28.9804,
      date: "2020-08"
    }
  };
}

function recognizedStreetView() {
  return {
    assetId: "plugin/google-streetview/hidden-pano.jpg",
    filePath: "/tmp/hidden-pano.jpg",
    metadataPath: "/tmp/hidden-pano.json",
    location: { lat: 41.0089, lng: 28.9804 },
    requestedLocation: { lat: 41.0089, lng: 28.9804 },
    coordinateBucket: "41.00890,28.98040",
    panoId: "hidden-pano",
    heading: 120,
    pitch: 0,
    fov: 90,
    source: "stored" as const,
    reused: true,
    metadata: locationPano().metadata,
    imageRecognition: {
      text: "A public square with a large historic building.",
      provider: "multimodal_llm" as const
    }
  };
}

function streetViewStub() {
  return {
    async getPanoGraphByCoordinates() {
      throw new Error("unexpected getPanoGraphByCoordinates call");
    },
    async getPanoGraphByPanoId() {
      throw new Error("unexpected getPanoGraphByPanoId call");
    },
    async getStreetViewByCoordinates() {
      throw new Error("unexpected getStreetViewByCoordinates call");
    }
  };
}

function tmpDir(): string {
  const root = path.join(os.tmpdir(), "alice-tests");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "alice-location-tool-"));
}
