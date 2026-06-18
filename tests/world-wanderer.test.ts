import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorldWandererRuntime,
  defaultWorldWandererInitialLocation,
  distanceMeters,
  readWorldWandererConfig,
  readWorldWandererState,
  writeWorldWandererConfig,
  writeWorldWandererState,
  type WorldWandererConfig
} from "../src/contexts/world-wanderer/src/index.js";
import type { GoogleStreetViewPanoGraphResult } from "../src/channels/google-streetview/src/index.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("world wanderer config defaults disabled near Hagia Sophia with pano graph policy", () => {
  const config = readWorldWandererConfig(path.join(tempRoot(), "missing.json"));

  assert.equal(config.enabled, false);
  assert.equal(config.libraryPrompt, "");
  assert.equal(config.speedMetersPerSecond, 1.4);
  assert.deepEqual(config.initialLocation, defaultWorldWandererInitialLocation);
  assert.equal(config.recentHistoryLimit, 100);
  assert.equal(config.maxPanosPerIdle, 10);
  assert.equal(config.noveltyWeight, 6);
  assert.equal(config.forwardWeight, 2);
  assert.equal(config.roadContinuityWeight, 1.5);
  assert.equal(config.uturnPenalty, 6);
  assert.equal(config.loopPenalty, 10);
  assert.equal(config.selectionTemperature, 1);
  assert.equal("headingJitterDegrees" in config, false);
});

test("world wanderer runtime reports enabled state from config", () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config({ enabled: false }));
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    googleStreetView: graphGoogleStreetView(new Map())
  });

  assert.equal(runtime.isEnabled(), false);
  writeWorldWandererConfig(configPath, config({ enabled: true }));
  assert.equal(runtime.isEnabled(), true);
});

test("world wanderer resolves initial coordinates and moves at least one pano", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config({ speedMetersPerSecond: 0 }));

  const graph = new Map([
    ["a", pano("a", 41.0086, 28.9802, [{ panoId: "b", heading: 90, text: "Road" }])],
    ["b", pano("b", 41.0086, 28.9812, [])]
  ]);
  const coordinateCalls: Array<{ lat: number; lng: number }> = [];
  const panoCalls: string[] = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph, coordinateCalls, panoCalls)
  });

  const state = await runtime.runIdleTransition({ delayMs: 0 });

  assert.ok(state);
  assert.deepEqual(coordinateCalls, [{ lat: 41.0086, lng: 28.9802 }]);
  assert.deepEqual(panoCalls, ["b"]);
  assert.equal(state.panoId, "b");
  assert.equal(state.lastHeading, 90);
  assert.equal(state.lastRoadText, "Road");
  assert.deepEqual(state.recentPanoIds, ["a", "b"]);
  assert.deepEqual(state.pathStack.map((entry) => entry.panoId), ["a"]);
  assert.deepEqual(readWorldWandererState(statePath, readWorldWandererConfig(configPath)).metadata, graph.get("b")!.metadata);
});

test("world wanderer probes nearby when current pano has no links", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config({ speedMetersPerSecond: 0 }));

  const next = pano("next", 41.0089, 28.9804, []);
  next.metadata.addressComponents = [
    { longName: "Ayasofya Meydani", types: ["route"] },
    { longName: "Turkiye", types: ["country", "political"] }
  ];
  next.metadata.formattedAddress = "Ayasofya Meydani, Istanbul, Turkiye";

  const graph = new Map([
    ["isolated", pano("isolated", 41.0086, 28.9802, [])],
    ["linked", pano("linked", 41.0088, 28.9802, [{ panoId: "next", heading: 90, text: "Ayasofya Meydani" }])],
    ["next", next]
  ]);
  const coordinateCalls: Array<{ lat: number; lng: number }> = [];
  const panoCalls: string[] = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates(input) {
        coordinateCalls.push(input);
        return coordinateCalls.length === 1 ? graph.get("isolated")! : graph.get("linked")!;
      },
      async getPanoGraphByPanoId(input) {
        panoCalls.push(input.panoId);
        const result = graph.get(input.panoId);
        if (!result) throw new Error("missing pano");
        return result;
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 0 });

  assert.ok(state);
  assert.equal(state.panoId, "next");
  assert.equal(coordinateCalls.length, 2);
  assert.ok(coordinateCalls[1]!.lat > coordinateCalls[0]!.lat);
  assert.deepEqual(panoCalls, ["next"]);
  assert.deepEqual(state.recentPanoIds, ["linked", "next"]);
  assert.deepEqual(state.pathStack.map((entry) => entry.panoId), ["linked"]);
  assert.deepEqual(state.metadata, next.metadata);
});

test("world wanderer accumulates actual pano distance before stopping", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config({ speedMetersPerSecond: 1, maxPanosPerIdle: 10 }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Road" }])],
    ["b", pano("b", 41, 29.001, [{ panoId: "c", heading: 90, text: "Road" }])],
    ["c", pano("c", 41, 29.002, [])]
  ]);
  const panoCalls: string[] = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph, [], panoCalls)
  });

  const state = await runtime.runIdleTransition({ delayMs: 150_000 });

  assert.ok(state);
  assert.equal(state.panoId, "c");
  assert.deepEqual(panoCalls, ["b", "c"]);
  assert.ok(distanceMeters(graph.get("a")!.location, graph.get("b")!.location) < 150);
  assert.ok(distanceMeters(graph.get("a")!.location, graph.get("c")!.location) >= 150);
});

test("world wanderer respects max panos per idle", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config({ maxPanosPerIdle: 3, speedMetersPerSecond: 10 }));

  const graph = chainGraph(8);
  const panoCalls: string[] = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph, [], panoCalls)
  });

  const state = await runtime.runIdleTransition({ delayMs: 1_000_000 });

  assert.ok(state);
  assert.equal(state.panoId, "p3");
  assert.deepEqual(panoCalls, ["p1", "p2", "p3"]);
});

test("world wanderer truncates recent pano history", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config({ recentHistoryLimit: 3, maxPanosPerIdle: 4, speedMetersPerSecond: 10 }));

  const graph = chainGraph(5);
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph)
  });

  const state = await runtime.runIdleTransition({ delayMs: 1_000_000 });

  assert.ok(state);
  assert.equal(state.panoId, "p4");
  assert.deepEqual(state.recentPanoIds, ["p2", "p3", "p4"]);
});

test("world wanderer softmax policy avoids recent loops when a novel link exists", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config({
    noveltyWeight: 6,
    forwardWeight: 0,
    roadContinuityWeight: 0,
    uturnPenalty: 0,
    loopPenalty: 10,
    selectionTemperature: 0.01
  }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [
      { panoId: "b", heading: 90, text: "Road" },
      { panoId: "c", heading: 270, text: "Road" }
    ])],
    ["b", pano("b", 41, 29.001, [])],
    ["c", pano("c", 41, 28.999, [])]
  ]);
  writeWorldWandererState(statePath, {
    location: graph.get("a")!.location,
    lastHeading: 90,
    metadata: graph.get("a")!.metadata,
    metadataLocation: graph.get("a")!.location,
    panoId: "a",
    recentPanoIds: ["b"],
    pathStack: [],
    updatedAt: "2026-06-17T00:00:00.000Z"
  });
  const panoCalls: string[] = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph, [], panoCalls)
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.ok(state);
  assert.equal(state.panoId, "c");
  assert.deepEqual(panoCalls, ["a", "c"]);
});

test("world wanderer backtracks through visible reverse link at recent dead end", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config());

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Road" }])],
    ["b", pano("b", 41, 29.001, [{ panoId: "a", heading: 270, text: "Road" }])]
  ]);
  writeWorldWandererState(statePath, {
    location: graph.get("b")!.location,
    lastHeading: 90,
    lastRoadText: "Road",
    metadata: graph.get("b")!.metadata,
    metadataLocation: graph.get("b")!.location,
    panoId: "b",
    recentPanoIds: ["a", "b"],
    pathStack: [{ panoId: "a", location: graph.get("a")!.location, heading: 0 }],
    updatedAt: "2026-06-17T00:00:00.000Z"
  });
  const panoCalls: string[] = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph, [], panoCalls)
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.ok(state);
  assert.equal(state.panoId, "a");
  assert.deepEqual(state.pathStack, []);
  assert.deepEqual(panoCalls, ["b", "a"]);
});

test("world wanderer records pano graph failure while preserving previous metadata", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, config());

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Road" }])],
    ["b", pano("b", 41, 29.001, [])]
  ]);
  let fail = false;
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date(fail ? "2026-06-17T00:01:00.000Z" : "2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates(input) {
        if (fail) throw new Error("no imagery");
        return { ...graph.get("a")!, location: { lat: input.lat, lng: input.lng } };
      },
      async getPanoGraphByPanoId(input) {
        if (fail) throw new Error("no imagery");
        const result = graph.get(input.panoId);
        if (!result) throw new Error("missing pano");
        return result;
      }
    }
  });

  const first = await runtime.runIdleTransition({ delayMs: 1 });
  fail = true;
  const second = await runtime.runIdleTransition({ delayMs: 1 });

  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(second.metadata, first.metadata);
  assert.equal(second.location.lng, first.location.lng);
  assert.equal(second.lastFailure?.message, "no imagery");
});

function config(patch: Partial<WorldWandererConfig> = {}): WorldWandererConfig {
  return {
    enabled: true,
    libraryPrompt: "",
    speedMetersPerSecond: 1.4,
    initialLocation: { lat: 41.0086, lng: 28.9802 },
    initialHeading: 90,
    recentHistoryLimit: 100,
    maxPanosPerIdle: 10,
    noveltyWeight: 6,
    forwardWeight: 2,
    roadContinuityWeight: 1.5,
    uturnPenalty: 6,
    loopPenalty: 10,
    selectionTemperature: 1,
    ...patch
  };
}

function pano(
  panoId: string,
  lat: number,
  lng: number,
  links: GoogleStreetViewPanoGraphResult["links"],
  heading = 0
): GoogleStreetViewPanoGraphResult {
  return {
    panoId,
    location: { lat, lng },
    heading,
    links,
    metadata: { panoId, lat, lng, heading, links }
  };
}

function chainGraph(count: number): Map<string, GoogleStreetViewPanoGraphResult> {
  const graph = new Map<string, GoogleStreetViewPanoGraphResult>();
  for (let index = 0; index < count; index += 1) {
    const current = `p${index}`;
    const next = index + 1 < count ? `p${index + 1}` : undefined;
    graph.set(current, pano(current, 41, 29 + index * 0.001, next ? [{ panoId: next, heading: 90, text: "Road" }] : []));
  }
  return graph;
}

function graphGoogleStreetView(
  graph: Map<string, GoogleStreetViewPanoGraphResult>,
  coordinateCalls: Array<{ lat: number; lng: number }> = [],
  panoCalls: string[] = []
) {
  return {
    async getPanoGraphByCoordinates(input: { lat: number; lng: number }) {
      coordinateCalls.push(input);
      const first = graph.values().next().value as GoogleStreetViewPanoGraphResult | undefined;
      if (!first) throw new Error("missing pano");
      return first;
    },
    async getPanoGraphByPanoId(input: { panoId: string }) {
      panoCalls.push(input.panoId);
      const result = graph.get(input.panoId);
      if (!result) throw new Error("missing pano");
      return result;
    }
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-world-wanderer-"));
  tempRoots.push(root);
  return root;
}
