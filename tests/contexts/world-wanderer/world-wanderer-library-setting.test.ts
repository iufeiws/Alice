import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLibrarySetting } from "../../../src/contexts/world-wanderer/src/admin-library-setting.js";
import { writeWorldWandererConfig } from "../../../src/contexts/world-wanderer/src/index.js";
import {
  worldWandererConfig,
  worldWandererPaths
} from "./world-wanderer-helpers.js";

test("library setting falls back to core profile while world wanderer is disabled", () => {
  const { configPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({
    enabled: false,
    libraryPrompt: "world-library-setting"
  }));

  assert.equal(resolveLibrarySetting(libraryContext(configPath, "core-library-setting")), "core-library-setting");
});

test("library setting uses world wanderer value while enabled", () => {
  const { configPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({
    enabled: true,
    libraryPrompt: "world-library-setting"
  }));

  assert.equal(resolveLibrarySetting(libraryContext(configPath, "core-library-setting")), "world-library-setting");
});

test("enabled world wanderer preserves an empty library setting", () => {
  const { configPath } = worldWandererPaths();
  writeWorldWandererConfig(configPath, worldWandererConfig({
    enabled: true,
    libraryPrompt: ""
  }));

  assert.equal(resolveLibrarySetting(libraryContext(configPath, "core-library-setting")), "");
});

function libraryContext(configPath: string, librarySetting: string): Parameters<typeof resolveLibrarySetting>[0] {
  return {
    pluginConfigs: { worldWanderer: { configPath } },
    coreProfileStore: { get: () => ({ appearanceDescription: "", librarySetting }) }
  } as Parameters<typeof resolveLibrarySetting>[0];
}
