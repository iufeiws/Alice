import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogleStreetViewPlugin } from "../../../src/channels/google-streetview/src/index.js";
import { bytesResponse, configWithOutput, jsonResponse, sequenceRandom, tempOutputRoot } from "./google-streetview-plugin-helpers.js";

test("random_samplesConfiguredRegionAndRetriesFailedCandidates", async () => {
  const root = tempOutputRoot();
  let metadataCalls = 0;
  const plugin = createGoogleStreetViewPlugin({
    config: {
      ...configWithOutput(root),
      randomAttempts: 2,
      maxRadiusMeters: 50,
      regions: [{
        id: "tokyo",
        bounds: { north: 36, south: 35, east: 140, west: 139 }
      }]
    },
    random: sequenceRandom([0, 0.5, 0.5, 0, 0.6, 0.6]),
    fetch: async (url) => {
      if (String(url).includes("/metadata")) {
        metadataCalls += 1;
        const parsed = new URL(String(url));
        const [lat, lng] = parsed.searchParams.get("location")!.split(",").map(Number);
        assert.ok(lat! >= 35 && lat! <= 36);
        assert.ok(lng! >= 139 && lng! <= 140);
        return jsonResponse(metadataCalls === 1
          ? { status: "ZERO_RESULTS" }
          : { status: "OK", pano_id: "random-pano", location: { lat, lng } });
      }
      return bytesResponse(new Uint8Array([7]));
    }
  });

  const result = await plugin.getRandomStreetView({ regionId: "tokyo" });

  assert.equal(result.reused, false);
  assert.equal(result.regionId, "tokyo");
  assert.equal(metadataCalls, 2);
});
