import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorldWandererRuntime,
  readWorldWandererConfig,
  writeWorldWandererConfig
} from "../../../src/contexts/world-wanderer/src/index.js";
import {
  graphGoogleStreetView,
  worldWandererConfig,
  worldWandererPaths
} from "./world-wanderer-helpers.js";

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
