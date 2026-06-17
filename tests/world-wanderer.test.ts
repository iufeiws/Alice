import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorldWandererRuntime,
  defaultWorldWandererInitialLocation,
  moveLocation,
  readWorldWandererConfig,
  readWorldWandererState,
  writeWorldWandererConfig
} from "../src/contexts/world-wanderer/src/index.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("world wanderer config defaults disabled near Hagia Sophia", () => {
  const config = readWorldWandererConfig(path.join(tempRoot(), "missing.json"));

  assert.equal(config.enabled, false);
  assert.equal(config.speedMetersPerSecond, 1.4);
  assert.equal(config.headingJitterDegrees, 30);
  assert.deepEqual(config.initialLocation, defaultWorldWandererInitialLocation);
});

test("world wanderer moves on idle transition and persists metadata", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, {
    enabled: true,
    speedMetersPerSecond: 1.4,
    headingJitterDegrees: 30,
    initialLocation: { lat: 41.0086, lng: 28.9802 },
    initialHeading: 90
  });

  const calls: Array<{ lat: number; lng: number }> = [];
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    random: () => 0.5,
    googleStreetView: {
      async getMetadataByCoordinates(input) {
        calls.push(input);
        return {
          requestedLocation: input,
          location: { lat: input.lat + 0.001, lng: input.lng + 0.001 },
          panoId: "pano-1",
          metadata: { status: "OK", pano_id: "pano-1" }
        };
      }
    }
  });

  const state = await runtime.runIdleTransition({ delayMs: 10_000 });
  const expected = moveLocation({ lat: 41.0086, lng: 28.9802 }, 90, 14);

  assert.ok(state);
  assert.equal(calls.length, 1);
  assert.ok(Math.abs(state.location.lat - expected.lat) < 0.000001);
  assert.ok(Math.abs(state.location.lng - expected.lng) < 0.000001);
  assert.equal(state.lastHeading, 90);
  assert.equal(state.panoId, "pano-1");
  assert.deepEqual(readWorldWandererState(statePath, readWorldWandererConfig(configPath)).metadata, { status: "OK", pano_id: "pano-1" });
});

test("world wanderer records metadata failure while preserving previous metadata", async () => {
  const root = tempRoot();
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  writeWorldWandererConfig(configPath, {
    enabled: true,
    speedMetersPerSecond: 1.4,
    headingJitterDegrees: 30,
    initialLocation: { lat: 41.0086, lng: 28.9802 },
    initialHeading: 90
  });

  let fail = false;
  const runtime = createWorldWandererRuntime({
    configPath,
    statePath,
    now: () => new Date(fail ? "2026-06-17T00:01:00.000Z" : "2026-06-17T00:00:00.000Z"),
    random: () => 0.5,
    googleStreetView: {
      async getMetadataByCoordinates(input) {
        if (fail) throw new Error("no imagery");
        return {
          requestedLocation: input,
          location: input,
          panoId: "pano-ok",
          metadata: { status: "OK", pano_id: "pano-ok" }
        };
      }
    }
  });

  const first = await runtime.runIdleTransition({ delayMs: 10_000 });
  fail = true;
  const second = await runtime.runIdleTransition({ delayMs: 10_000 });

  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(second.metadata, first.metadata);
  assert.equal(second.lastFailure?.message, "no imagery");
  assert.notDeepEqual(second.location, first.location);
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-world-wanderer-"));
  tempRoots.push(root);
  return root;
}
