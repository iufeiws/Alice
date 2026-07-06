import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogleStreetViewPlugin } from "../../../src/channels/google-streetview/src/index.js";
import {
  bytesResponse,
  configWithOutput,
  fs,
  jsonResponse,
  path,
  storedMetadata,
  tempOutputRoot,
  writeStoredResult
} from "./google-streetview-plugin-helpers.js";

test("provider_fetchesMetadataAndStoresImage", async () => {
  const root = tempOutputRoot();
  const requests: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/metadata")) {
        return jsonResponse({ status: "OK", pano_id: "pano-1", location: { lat: 35.1, lng: 139.1 } });
      }
      return bytesResponse(new Uint8Array([1, 2, 3, 4]));
    }
  });

  const result = await plugin.getStreetViewByCoordinates({ lat: 35, lng: 139, regionId: "tokyo" });

  assert.equal(result.reused, false);
  assert.equal(result.source, "google_streetview_static");
  assert.equal(result.regionId, "tokyo");
  assert.equal(result.panoId, "pano-1");
  assert.equal(result.location.lat, 35.1);
  assert.equal(path.basename(result.filePath), "pano-1.jpg");
  assert.equal(path.basename(result.metadataPath), "pano-1.json");
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(storedMetadata(root, "pano-1").pano_id, "pano-1");
  assert.equal(requests.filter((url) => url.includes("/metadata")).length, 1);
  assert.equal(requests.filter((url) => !url.includes("/metadata")).length, 1);
});

test("provider_reusesStoredPanoWithoutDownloadingImageAgain", async () => {
  const root = tempOutputRoot();
  const requests: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/metadata")) {
        return jsonResponse({ status: "OK", pano_id: "pano-repeat", location: { lat: 35.1, lng: 139.1 } });
      }
      return bytesResponse(new Uint8Array([5]));
    }
  });

  const first = await plugin.getStreetViewByCoordinates({ lat: 35, lng: 139 });
  const second = await plugin.getStreetViewByCoordinates({ lat: 35, lng: 139 });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.filePath, first.filePath);
  assert.equal(requests.filter((url) => url.includes("/metadata")).length, 2);
  assert.equal(requests.filter((url) => !url.includes("/metadata")).length, 1);
});

test("provider_metadataLookupStoresMetadataWithoutImageDownload", async () => {
  const root = tempOutputRoot();
  const requests: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    fetch: async (url) => {
      requests.push(String(url));
      return jsonResponse({ status: "OK", pano_id: "pano-meta", location: { lat: 41.01, lng: 28.98 } });
    }
  });

  const result = await plugin.getMetadataByCoordinates({ lat: 41, lng: 29 });

  assert.equal(result.panoId, "pano-meta");
  assert.equal(result.location.lat, 41.01);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.includes("/metadata"), true);
  assert.equal(storedMetadata(root, "pano-meta").pano_id, "pano-meta");
});

test("provider_reusesStoredPanoFoundAfterMetadataLookup", async () => {
  const root = tempOutputRoot();
  const stored = writeStoredResult(root, "pano-stored.jpg", "pano-stored");
  const requests: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/metadata")) {
        return jsonResponse({ status: "OK", pano_id: "pano-stored", location: { lat: 35, lng: 139 } });
      }
      throw new Error("image fetch should not be called");
    }
  });

  const result = await plugin.getStreetViewByCoordinates({ lat: 35, lng: 139 });

  assert.equal(result.reused, true);
  assert.equal(result.source, "stored");
  assert.equal(result.assetId, stored.assetId);
  assert.equal(requests.length, 1);
});

test("provider_reusesStoredPanoAcrossCoordinates", async () => {
  const root = tempOutputRoot();
  const stored = writeStoredResult(root, "pano-shared.jpg", "pano-shared", { lat: 36, lng: 140 });
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    fetch: async (url) => {
      if (String(url).includes("/metadata")) {
        return jsonResponse({ status: "OK", pano_id: "pano-shared", location: { lat: 36, lng: 140 } });
      }
      throw new Error("image fetch should not be called");
    }
  });

  const result = await plugin.getStreetViewByCoordinates({ lat: 36, lng: 140, reuseStoredForLocation: true });

  assert.equal(result.reused, true);
  assert.equal(result.assetId, stored.assetId);
});

test("provider_expandsMetadataRadiusUntilMaxRadius", async () => {
  const root = tempOutputRoot();
  const radii: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: {
      ...configWithOutput(root),
      initialRadiusMeters: 10,
      radiusExpansionFactor: 2,
      maxRadiusMeters: 40
    },
    fetch: async (url) => {
      radii.push(new URL(String(url)).searchParams.get("radius") ?? "");
      return jsonResponse({ status: "ZERO_RESULTS" });
    }
  });

  await assert.rejects(
    () => plugin.getStreetViewByCoordinates({ lat: 35, lng: 139 }),
    /no imagery/
  );
  assert.deepEqual(radii, ["10", "20", "40"]);
});
