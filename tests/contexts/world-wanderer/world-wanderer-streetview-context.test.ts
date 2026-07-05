import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorldWandererRuntime,
  readWorldWandererConfig,
  readWorldWandererState,
  writeWorldWandererConfig
} from "../../../src/contexts/world-wanderer/src/index.js";
import {
  graphGoogleStreetView,
  pano,
  pathPanoIds,
  worldWandererConfig,
  worldWandererPaths
} from "./world-wanderer-helpers.js";

test("world wanderer starts from configured coordinates", async () => {
  const { coordinateCalls } = await runConfiguredWorldWanderer();
  assert.deepEqual(coordinateCalls, [{ lat: 41.0086, lng: 28.9802 }]);
});

test("world wanderer moves to linked pano", async () => {
  const { state } = await runConfiguredWorldWanderer();
  assert.ok(state);
  assert.equal(state.panoId, "b");
  assert.equal(state.lastHeading, 90);
  assert.deepEqual(pathPanoIds(state), ["a", "b"]);
});

test("world wanderer persists the moved pano", async () => {
  const { configPath, dbPath } = await runConfiguredWorldWanderer();
  assert.equal(readWorldWandererState(dbPath, readWorldWandererConfig(configPath)).panoId, "b");
});

async function runConfiguredWorldWanderer() {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ speedMetersPerSecond: 0 }));

  const graph = new Map([
    ["a", pano("a", 41.0086, 28.9802, [{ panoId: "b", heading: 90, text: "Road" }])],
    ["b", pano("b", 41.0086, 28.9812, [])]
  ]);
  const coordinateCalls: Array<{ lat: number; lng: number }> = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: graphGoogleStreetView(graph, coordinateCalls)
  });

  const state = await runtime.runIdleTransition({ delayMs: 0 });
  return { configPath, dbPath, coordinateCalls, state };
}

test("world wanderer probes nearby when current pano has no links", async () => {
  const { coordinateCalls } = await runNearbyWorldWanderer();
  assert.equal(coordinateCalls.length, 2);
});

test("world wanderer moves through nearby pano links", async () => {
  const { next, state } = await runNearbyWorldWanderer();
  assert.ok(state);
  assert.equal(state.panoId, "next");
  assert.deepEqual(pathPanoIds(state), ["linked", "next"]);
  assert.equal(state.location.lat, next.location.lat);
});

async function runNearbyWorldWanderer() {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ speedMetersPerSecond: 0 }));

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
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates(input) {
        coordinateCalls.push(input);
        return coordinateCalls.length === 1 ? graph.get("isolated")! : graph.get("linked")!;
      },
      async getPanoGraphByPanoId(input) {
        const result = graph.get(input.panoId);
        if (!result) throw new Error("missing pano");
        return result;
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 0 });
  return { coordinateCalls, next, state };
}

test("world wanderer preserves previous position when streetview graph lookup fails", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig());

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Road" }])],
    ["b", pano("b", 41, 29.001, [])]
  ]);
  let fail = false;
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
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
  assert.equal(second.panoId, first.panoId);
  assert.equal(second.location.lng, first.location.lng);
});
