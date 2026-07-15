import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorldWandererRuntime,
  distanceMeters,
  readWorldWandererConfig,
  writeWorldWandererConfig,
  writeWorldWandererState
} from "../../../src/contexts/world-wanderer/src/index.js";
import {
  chainGraph,
  graphGoogleStreetView,
  pano,
  pathPanoIds,
  worldWandererConfig,
  worldWandererPaths
} from "./world-wanderer-helpers.js";

test("world wanderer accumulates actual pano distance before stopping", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ speedMetersPerSecond: 1, maxPanosPerIdle: 10 }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Road" }])],
    ["b", pano("b", 41, 29.001, [{ panoId: "c", heading: 90, text: "Road" }])],
    ["c", pano("c", 41, 29.002, [])]
  ]);
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph)
  });

  const state = await runtime.runIdleTransition({ delayMs: 150_000 });

  assert.ok(state);
  assert.equal(state.panoId, "c");
  assert.ok(distanceMeters(graph.get("a")!.location, graph.get("b")!.location) < 150);
  assert.ok(distanceMeters(graph.get("a")!.location, graph.get("c")!.location) >= 150);
});

test("world wanderer respects max panos per idle", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ maxPanosPerIdle: 3, speedMetersPerSecond: 10 }));

  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(chainGraph(8))
  });

  const state = await runtime.runIdleTransition({ delayMs: 1_000_000 });

  assert.ok(state);
  assert.equal(state.panoId, "p3");
});

test("world wanderer truncates recent pano history", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ recentHistoryLimit: 3, maxPanosPerIdle: 4, speedMetersPerSecond: 10 }));

  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(chainGraph(5))
  });

  const state = await runtime.runIdleTransition({ delayMs: 1_000_000 });

  assert.ok(state);
  assert.equal(state.panoId, "p4");
  assert.deepEqual(pathPanoIds(state), ["p2", "p3", "p4"]);
});

test("world wanderer avoids recent loops when a novel link exists", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({
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
  writeWorldWandererState(dbPath, {
    location: graph.get("a")!.location,
    lastHeading: 90,
    panoId: "a",
    pathStack: [
      { time: "2026-06-17T00:00:00.000Z", panoId: "b", lat: graph.get("b")!.location.lat, lng: graph.get("b")!.location.lng, lastHeading: 90 },
      { time: "2026-06-17T00:00:01.000Z", panoId: "a", lat: graph.get("a")!.location.lat, lng: graph.get("a")!.location.lng, lastHeading: 90 }
    ]
  });
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph)
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.ok(state);
  assert.equal(state.panoId, "c");
});

test("world wanderer target direction policy uses forward weight", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({
    initialHeading: 0,
    initialLocation: { lat: 41, lng: 29 },
    targetLocation: { lat: 41, lng: 29.01 },
    speedMetersPerSecond: 0,
    noveltyWeight: 0,
    forwardWeight: 2,
    roadContinuityWeight: 0,
    uturnPenalty: 0,
    loopPenalty: 0,
    selectionTemperature: 0.01
  }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [
      { panoId: "east", heading: 90, text: "Road" },
      { panoId: "west", heading: 270, text: "Road" }
    ])],
    ["east", pano("east", 41, 29.001, [])],
    ["west", pano("west", 41, 28.999, [])]
  ]);
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph)
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.ok(state);
  assert.equal(state.panoId, "east");
});

test("world wanderer clears target location when close enough", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({
    initialLocation: { lat: 41, lng: 29 },
    targetLocation: { lat: 41, lng: 29.0001 },
    speedMetersPerSecond: 0
  }));

  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(new Map([
      ["a", pano("a", 41, 29, [])]
    ]))
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.equal(state?.targetReached, true);
  assert.equal(readWorldWandererConfig(configPath).targetLocation, undefined);
});

test("world wanderer retries failed link through google streetview then changes link", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({
    initialHeading: 90,
    initialLocation: { lat: 41, lng: 29 },
    targetLocation: { lat: 41, lng: 29.01 },
    speedMetersPerSecond: 10,
    noveltyWeight: 0,
    forwardWeight: 2,
    roadContinuityWeight: 0,
    uturnPenalty: 0,
    loopPenalty: 0,
    selectionTemperature: 0.01
  }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [
      { panoId: "bad", heading: 90, text: "Road" },
      { panoId: "fallback", heading: 270, text: "Road" }
    ])],
    ["fallback", pano("fallback", 41, 28.999, [])]
  ]);
  writeWorldWandererState(dbPath, {
    location: graph.get("a")!.location,
    lastHeading: 90,
    panoId: "a",
    pathStack: [
      { time: "2026-06-17T00:00:00.000Z", panoId: "fallback", lat: graph.get("fallback")!.location.lat, lng: graph.get("fallback")!.location.lng, lastHeading: 270 },
      { time: "2026-06-17T00:00:01.000Z", panoId: "a", lat: graph.get("a")!.location.lat, lng: graph.get("a")!.location.lng, lastHeading: 90 }
    ]
  });
  let badCalls = 0;
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates() {
        throw new Error("nearby probe should not discard moved pano");
      },
      async getPanoGraphByPanoId(input) {
        if (input.panoId === "bad") {
          badCalls += 1;
          throw new Error("bad pano");
        }
        const result = graph.get(input.panoId);
        if (!result) throw new Error("missing pano");
        return result;
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 100_000 });

  assert.ok(state);
  assert.equal(state.panoId, "fallback");
  assert.equal(badCalls, 1);
});

test("world wanderer probes nearby instead of backtracking at recent dead end", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig());

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Road" }])],
    ["b", pano("b", 41, 29.001, [{ panoId: "a", heading: 270, text: "Road" }])],
    ["escape", pano("escape", 41.001, 29.001, [{ panoId: "c", heading: 90, text: "Road" }])],
    ["c", pano("c", 41.001, 29.002, [])]
  ]);
  writeWorldWandererState(dbPath, {
    location: graph.get("b")!.location,
    lastHeading: 90,
    panoId: "b",
    pathStack: [
      { time: "2026-06-17T00:00:00.000Z", panoId: "a", lat: graph.get("a")!.location.lat, lng: graph.get("a")!.location.lng, lastHeading: 0 },
      { time: "2026-06-17T00:00:01.000Z", panoId: "b", lat: graph.get("b")!.location.lat, lng: graph.get("b")!.location.lng, lastHeading: 90 }
    ]
  });
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates() {
        return graph.get("escape")!;
      },
      async getPanoGraphByPanoId(input) {
        const result = graph.get(input.panoId);
        if (!result) throw new Error("missing pano");
        return result;
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.ok(state);
  assert.equal(state.panoId, "c");
  assert.deepEqual(pathPanoIds(state), ["escape", "c"]);
});
