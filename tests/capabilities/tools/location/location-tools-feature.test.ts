import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocationTools } from "../../../../src/capabilities/tools/location/src/index.js";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createToolOutputTargetResolver } from "../../../../src/contexts/capabilities/src/tool-output-target.js";
import { createAliceStore } from "../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
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
  assert.deepEqual(inputSchema.properties.action.enum, ["current", "send", "move", "teleport", "navigation"]);
  assert.deepEqual(inputSchema.required, ["action"]);
  assert.equal(inputSchema.additionalProperties, false);
  assert.equal(inputSchema.properties.lat.type, "number");
  assert.equal(inputSchema.properties.lat.minimum, -90);
  assert.equal(inputSchema.properties.lat.maximum, 90);
  assert.equal(inputSchema.properties.lng.type, "number");
  assert.equal(inputSchema.properties.lng.minimum, -180);
  assert.equal(inputSchema.properties.lng.maximum, 180);
  assert.equal(inputSchema.oneOf, undefined);
  assert.equal(tools.listTools()[0].sendsMessage, undefined);
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

test("Panorama send sends and persists the current pano image without counting the tool as a message sender", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const store = createAliceStore(path.join(root, "messages.sqlite"));
  const baseConfig = readWorldWandererConfig(configPath);
  const streetViewInputs: Array<Record<string, unknown>> = [];
  const sent: AgentOutput[] = [];
  const target = { plugin: "feishu", channelId: "chat-1", sessionId: "session-1" };
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
    now: () => nowIso,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-08-11T12:00:00.000Z")),
    store,
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "om_pano_1" };
      }
    },
    resolveOutputTarget: createToolOutputTargetResolver({ getDefaultTarget: () => target })
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  writeWorldWandererState(dbPath, {
    location: { lat: 41.0089, lng: 28.9804 },
    lastHeading: 90,
    panoId: "hidden-pano",
    pathStack: [{ time: "2026-06-18T00:00:00.000", panoId: "hidden-pano", lat: 41.0089, lng: 28.9804, lastHeading: 90 }]
  });

  const result = await tools.execute({ id: "call_location", toolName: "Panorama", input: { action: "send" } });

  assert.deepEqual(streetViewInputs, [{ lat: 41.0089, lng: 28.9804 }]);
  assert.equal(result.ok, true);
  assert.equal(result.output, "plugin/google-streetview/hidden-pano.jpg");
  assert.deepEqual(sent.map((output) => output.target), [{
    plugin: "feishu",
    accountId: undefined,
    channelId: "chat-1",
    userId: undefined,
    sessionId: "session-1"
  }]);
  assert.deepEqual(sent.map((output) => output.content), [{
    kind: "image",
    assetId: "plugin/google-streetview/hidden-pano.jpg"
  }]);
  assert.deepEqual(store.listMessagesForConversation("session-1", 10).map((message) => ({
    contentType: message.contentType,
    contentText: message.contentText
  })), [{
    contentType: "image",
    contentText: "plugin/google-streetview/hidden-pano.jpg"
  }]);
  assert.equal(tools.listTools()[0].sendsMessage, undefined);
});

test("Panorama move performs exactly one move with the current World Wanderer policy", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const graph = new Map([
    ["start", {
      panoId: "start",
      location: { lat: 41, lng: 29 },
      heading: 90,
      links: [
        { panoId: "back", heading: 270, text: "Road" },
        { panoId: "front", heading: 90, text: "Road" }
      ],
      metadata: {}
    }],
    ["back", { panoId: "back", location: { lat: 41, lng: 28.999 }, heading: 270, links: [], metadata: {} }],
    ["front", { panoId: "front", location: { lat: 41, lng: 29.001 }, heading: 90, links: [], metadata: {} }]
  ]);
  const requestedPanoIds: string[] = [];
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        throw new Error("unexpected getPanoGraphByCoordinates call");
      },
      async getPanoGraphByPanoId(input) {
        requestedPanoIds.push(input.panoId);
        const pano = graph.get(input.panoId);
        if (!pano) throw new Error("missing pano");
        return pano;
      },
      async getStreetViewByCoordinates() {
        throw new Error("unexpected getStreetViewByCoordinates call");
      }
    }),
    now: () => nowIso,
    random: () => 0.5
  });
  writeWorldWandererConfig(configPath, {
    ...baseConfig,
    enabled: true,
    selectionTemperature: 0.01
  });
  writeWorldWandererState(dbPath, {
    location: { lat: 41, lng: 29 },
    lastHeading: 90,
    panoId: "start",
    pathStack: [{ time: "2026-08-11T11:00:00.000", panoId: "start", lat: 41, lng: 29, lastHeading: 90 }]
  });

  const result = await tools.execute({ id: "call_location", toolName: "Panorama", input: { action: "move" } });

  assert.equal(result.ok, true);
  assert.equal(result.output, JSON.stringify({ lat: 41, lng: 29.001 }));
  assert.deepEqual(requestedPanoIds, ["start", "front"]);
  const state = readWorldWandererState(dbPath, readWorldWandererConfig(configPath));
  assert.equal(state.panoId, "front");
  assert.equal(state.lastHeading, 90);
  assert.deepEqual(state.pathStack.map((entry) => entry.panoId), ["start", "front"]);
});

test("Panorama move returns an explicit error when no movement is available", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const isolated = {
    panoId: "isolated",
    location: { lat: 41, lng: 29 },
    heading: 90,
    links: [],
    metadata: {}
  };
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        return isolated;
      },
      async getPanoGraphByPanoId() {
        return isolated;
      },
      async getStreetViewByCoordinates() {
        throw new Error("unexpected getStreetViewByCoordinates call");
      }
    }),
    now: () => nowIso
  });
  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  writeWorldWandererState(dbPath, {
    location: isolated.location,
    lastHeading: 90,
    panoId: isolated.panoId,
    pathStack: [{ time: "2026-08-11T11:00:00.000", panoId: isolated.panoId, lat: 41, lng: 29, lastHeading: 90 }]
  });

  const result = await tools.execute({ id: "call_location", toolName: "Panorama", input: { action: "move" } });

  assert.equal(result.ok, false);
  assert.equal(result.error, "location_move_unavailable");
  assert.equal(readWorldWandererState(dbPath, readWorldWandererConfig(configPath)).panoId, "isolated");
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
