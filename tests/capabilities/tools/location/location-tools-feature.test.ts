import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocationTools } from "../../../../src/capabilities/tools/location/src/index.js";
import {
  readWorldWandererConfig,
  writeWorldWandererConfig,
  writeWorldWandererState
} from "../../../../src/contexts/world-wanderer/src/index.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

test("check_location is listed only while world wanderer is enabled", () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        return locationPano();
      },
      async getPanoGraphByPanoId() {
        return locationPano();
      }
    })
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: false });
  assert.deepEqual(tools.listTools(), []);

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  assert.deepEqual(tools.listTools().map((tool) => tool.name), ["check_location"]);
});

test("check_location returns readable place text without raw location ids", async () => {
  const root = tmpDir();
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        return locationPano();
      },
      async getPanoGraphByPanoId() {
        return locationPano();
      }
    })
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  writeWorldWandererState(dbPath, {
    location: { lat: 41.0089, lng: 28.9804 },
    lastHeading: 90,
    panoId: "hidden-pano",
    pathStack: [{ time: "2026-06-18T00:00:00.000Z", panoId: "hidden-pano", lat: 41.0089, lng: 28.9804, lastHeading: 90 }]
  });

  const result = await tools.execute({ id: "call_location", toolName: "check_location", input: {} });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Ayasofya Meydani, Istanbul, Turkiye\nRecord date: 2020-08");
  assert.doesNotMatch(String(result.output), /hidden-pano|41\.0089|28\.9804/);
});

function locationPano() {
  return {
    panoId: "hidden-pano",
    location: { lat: 41.0089, lng: 28.9804 },
    heading: 90,
    links: [],
    metadata: {
      formattedAddress: "Ayasofya Meydani, Istanbul, Turkiye",
      panoId: "hidden-pano",
      lat: 41.0089,
      lng: 28.9804,
      date: "2020-08"
    }
  };
}

function tmpDir(): string {
  const root = path.join(os.tmpdir(), "alice-tests");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "alice-location-tool-"));
}
