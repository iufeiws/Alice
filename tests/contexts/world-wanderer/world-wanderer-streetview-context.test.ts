import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorldWandererRuntime,
  readWorldWandererConfig,
  readWorldWandererState,
  writeWorldWandererConfig,
  writeWorldWandererState
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

test("world wanderer escapes a recently exhausted local pano loop through a nearby linked pano", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ speedMetersPerSecond: 0 }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Loop" }])],
    ["b", pano("b", 41, 29.001, [{ panoId: "a", heading: 270, text: "Loop" }])],
    ["escape", pano("escape", 41.0003, 29.001, [{ panoId: "next", heading: 0, text: "New road" }])],
    ["next", pano("next", 41.0013, 29.001, [])]
  ]);
  writeWorldWandererState(dbPath, {
    location: graph.get("b")!.location,
    lastHeading: 90,
    panoId: "b",
    pathStack: [
      { time: "2026-06-17T00:00:00.000Z", panoId: "a", lat: 41, lng: 29, lastHeading: 90 },
      { time: "2026-06-17T00:00:01.000Z", panoId: "b", lat: 41, lng: 29.001, lastHeading: 90 },
      { time: "2026-06-17T00:00:02.000Z", panoId: "a", lat: 41, lng: 29, lastHeading: 270 },
      { time: "2026-06-17T00:00:03.000Z", panoId: "b", lat: 41, lng: 29.001, lastHeading: 90 }
    ]
  });
  const coordinateCalls: Array<{ lat: number; lng: number }> = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates(input) {
        coordinateCalls.push(input);
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
  assert.equal(state.panoId, "next");
  assert.deepEqual(pathPanoIds(state), ["escape", "next"]);
  assert.equal(coordinateCalls.length, 1);
});

test("world wanderer attempts nearby loop escape only once per idle transition", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ speedMetersPerSecond: 0 }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Loop" }])],
    ["b", pano("b", 41, 29.001, [{ panoId: "a", heading: 270, text: "Loop" }])]
  ]);
  writeWorldWandererState(dbPath, {
    location: graph.get("b")!.location,
    lastHeading: 90,
    panoId: "b",
    pathStack: [
      { time: "2026-06-17T00:00:00.000Z", panoId: "a", lat: 41, lng: 29, lastHeading: 90 },
      { time: "2026-06-17T00:00:01.000Z", panoId: "b", lat: 41, lng: 29.001, lastHeading: 90 },
      { time: "2026-06-17T00:00:02.000Z", panoId: "a", lat: 41, lng: 29, lastHeading: 270 },
      { time: "2026-06-17T00:00:03.000Z", panoId: "b", lat: 41, lng: 29.001, lastHeading: 90 }
    ]
  });
  let coordinateCalls = 0;
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates() {
        coordinateCalls += 1;
        return graph.get("a")!;
      },
      async getPanoGraphByPanoId(input) {
        if (input.panoId === "a") throw new Error("linked pano unavailable");
        const result = graph.get(input.panoId);
        if (!result) throw new Error("missing pano");
        return result;
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.equal(state?.panoId, "b");
  assert.equal(coordinateCalls, 8);
});

test("world wanderer searches nearby only once when the current pano has no links", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ speedMetersPerSecond: 0 }));

  const isolated = pano("isolated", 41, 29, []);
  writeWorldWandererState(dbPath, {
    location: isolated.location,
    lastHeading: 90,
    panoId: isolated.panoId,
    pathStack: [
      { time: "2026-06-17T00:00:00.000Z", panoId: isolated.panoId, lat: 41, lng: 29, lastHeading: 90 }
    ]
  });
  let coordinateCalls = 0;
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates() {
        coordinateCalls += 1;
        return isolated;
      },
      async getPanoGraphByPanoId() {
        return isolated;
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.equal(state?.panoId, "isolated");
  assert.equal(coordinateCalls, 8);
});

test("world wanderer escapes a loop discovered after moving during the idle transition", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ speedMetersPerSecond: 10, maxPanosPerIdle: 10 }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Loop" }])],
    ["b", pano("b", 41, 29.001, [{ panoId: "a", heading: 270, text: "Loop" }])],
    ["escape", pano("escape", 41.0003, 29, [{ panoId: "next", heading: 0, text: "New road" }])],
    ["next", pano("next", 41.0013, 29, [])]
  ]);
  writeWorldWandererState(dbPath, {
    location: graph.get("a")!.location,
    lastHeading: 90,
    panoId: "a",
    pathStack: [
      { time: "2026-06-17T00:00:00.000Z", panoId: "a", lat: 41, lng: 29, lastHeading: 90 }
    ]
  });
  let coordinateCalls = 0;
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates() {
        coordinateCalls += 1;
        return graph.get("escape")!;
      },
      async getPanoGraphByPanoId(input) {
        const result = graph.get(input.panoId);
        if (!result) throw new Error("missing pano");
        return result;
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 100_000 });

  assert.equal(state?.panoId, "next");
  assert.deepEqual(state && pathPanoIds(state), ["escape", "next"]);
  assert.equal(coordinateCalls, 1);
});

test("world wanderer follows a revisited link when nearby loop escape is unavailable", async () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ speedMetersPerSecond: 0 }));

  const graph = new Map([
    ["a", pano("a", 41, 29, [{ panoId: "b", heading: 90, text: "Loop" }])],
    ["b", pano("b", 41, 29.001, [{ panoId: "a", heading: 270, text: "Loop" }])]
  ]);
  writeWorldWandererState(dbPath, {
    location: graph.get("b")!.location,
    lastHeading: 90,
    panoId: "b",
    pathStack: [
      { time: "2026-06-17T00:00:00.000Z", panoId: "a", lat: 41, lng: 29, lastHeading: 90 },
      { time: "2026-06-17T00:00:01.000Z", panoId: "b", lat: 41, lng: 29.001, lastHeading: 90 },
      { time: "2026-06-17T00:00:02.000Z", panoId: "a", lat: 41, lng: 29, lastHeading: 270 },
      { time: "2026-06-17T00:00:03.000Z", panoId: "b", lat: 41, lng: 29.001, lastHeading: 90 }
    ]
  });
  let coordinateCalls = 0;
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    now: () => new Date("2026-06-17T00:01:00.000Z"),
    random: () => 0,
    googleStreetView: {
      async getPanoGraphByCoordinates() {
        coordinateCalls += 1;
        return graph.get("a")!;
      },
      async getPanoGraphByPanoId(input) {
        const result = graph.get(input.panoId);
        if (!result) throw new Error("missing pano");
        return result;
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 1 });

  assert.equal(state?.panoId, "a");
  assert.equal(coordinateCalls, 8);
});

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
