import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogleStreetViewPlugin } from "../../../src/channels/google-streetview/src/index.js";
import { configWithOutput, tempOutputRoot } from "./google-streetview-plugin-helpers.js";

test("plugin_exposesIdAndRuntimeConfig", () => {
  const outputDir = tempOutputRoot();
  const plugin = createGoogleStreetViewPlugin({ config: configWithOutput(outputDir) });

  assert.equal(plugin.id, "google_streetview");
  assert.equal(plugin.config.enabled, true);
  assert.equal(plugin.config.outputDir, outputDir);
});
