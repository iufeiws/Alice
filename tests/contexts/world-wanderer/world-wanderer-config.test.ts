import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorldWandererRuntime,
  defaultWorldWandererInitialLocation,
  readWorldWandererConfig,
  writeWorldWandererConfig
} from "../../../src/contexts/world-wanderer/src/index.js";
import {
  graphGoogleStreetView,
  worldWandererConfig,
  worldWandererPaths
} from "./world-wanderer-helpers.js";

test("world wanderer config defaults to disabled with stable movement settings", () => {
  const { configPath } = worldWandererPaths();
  const config = readWorldWandererConfig(configPath);

  assert.equal(config.enabled, false);
  assert.equal(config.libraryPrompt, "");
  assert.equal(config.mapsJavaScriptApiKey, "");
  assert.deepEqual(config.initialLocation, defaultWorldWandererInitialLocation);
  assert.equal(config.targetLocation, undefined);
  assert.equal(config.initialHeading, 90);
  assert.equal(config.speedMetersPerSecond, 1.4);
  assert.equal(config.recentHistoryLimit, 100);
  assert.equal(config.maxPanosPerIdle, 10);
  assert.equal(config.selectionTemperature, 1);
});

test("world wanderer runtime reads enabled state from config file", () => {
  const { configPath, dbPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({ enabled: false }));
  const runtime = createWorldWandererRuntime({
    configPath,
    dbPath,
    googleStreetView: graphGoogleStreetView(new Map())
  });

  assert.equal(runtime.isEnabled(), false);
  writeWorldWandererConfig(configPath, worldWandererConfig({ enabled: true }));
  assert.equal(runtime.isEnabled(), true);
});
