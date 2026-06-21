import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocationTools, readableWorldWandererLocationText } from "../src/capabilities/tools/location/src/index.js";
import {
  readWorldWandererConfig,
  writeWorldWandererConfig,
  writeWorldWandererState
} from "../src/contexts/world-wanderer/src/index.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

test("check_location is exposed only while world wanderer is enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-location-tool-"));
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "alice.sqlite");
  const baseConfig = readWorldWandererConfig(configPath);
  const tools = createLocationTools({
    configPath,
    dbPath,
    getGoogleStreetView: () => ({
      async getPanoGraphByCoordinates() {
        throw new Error("panoId should be used");
      },
      async getPanoGraphByPanoId(input) {
        assert.equal(input.panoId, "hidden-pano");
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
    }),
    now: () => new Date("2026-06-18T00:00:00.000Z")
  });

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: false });
  assert.deepEqual(tools.listTools(), []);

  writeWorldWandererConfig(configPath, { ...baseConfig, enabled: true });
  assert.deepEqual(tools.listTools().map((tool) => tool.name), ["check_location"]);

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

test("readableWorldWandererLocationText falls back to address component names", () => {
  assert.equal(
    readableWorldWandererLocationText({
      addressComponents: [
        { longName: "Ayasofya Meydani" },
        { short_name: "TR" },
        { longName: "Ayasofya Meydani" }
      ],
      panoId: "hidden-pano",
      lat: 41.0089,
      date: "2020-08",
      lng: 28.9804
    }),
    "Ayasofya Meydani, TR\nRecord date: 2020-08"
  );
});
