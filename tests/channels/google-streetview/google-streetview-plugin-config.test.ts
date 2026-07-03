import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publicGoogleStreetViewPluginConfig,
  readGoogleStreetViewPluginConfig,
  validateGoogleStreetViewPluginConfig
} from "../../../src/channels/google-streetview/src/index.js";
import { configWithOutput, missingConfigPath } from "./google-streetview-plugin-helpers.js";

test("config_readsEnvApiKeyAndHidesSecret", () => {
  const config = readGoogleStreetViewPluginConfig(missingConfigPath(), {}, { GOOGLE_STREETVIEW_API_KEY: "secret" });
  const publicConfig = publicGoogleStreetViewPluginConfig(config);

  assert.equal(config.apiKey, "secret");
  assert.equal(config.outputDir, "assets/plugin/google-streetview");
  assert.equal(publicConfig.apiKeySet, true);
  assert.equal("apiKey" in publicConfig, false);
});

test("config_rejectsUnsafeOutputDirs", () => {
  assert.equal(validateGoogleStreetViewPluginConfig(configWithOutput("assets/generated/streetview")), "invalid_output_dir");
  assert.equal(validateGoogleStreetViewPluginConfig(configWithOutput("/tmp/google-streetview")), "invalid_output_dir");
  assert.equal(validateGoogleStreetViewPluginConfig(configWithOutput("assets/plugin/google-streetview/cache")), undefined);
});
