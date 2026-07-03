import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogleStreetViewPlugin } from "../../../src/channels/google-streetview/src/index.js";
import { configWithOutput, jsonResponse, storedMetadata, tempOutputRoot } from "./google-streetview-plugin-helpers.js";

test("panoGraph_reusesActiveMapTilesSessionAndCachesPanoMetadata", async () => {
  const root = tempOutputRoot();
  let nowMs = Date.parse("2026-06-17T00:00:00.000Z");
  let sessionCalls = 0;
  const metadataRequests: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    now: () => new Date(nowMs),
    fetch: async (url) => {
      const text = String(url);
      if (text.includes("/createSession")) {
        sessionCalls += 1;
        return jsonResponse({ session: `session-${sessionCalls}`, expiry: String((nowMs + 120_000) / 1000) });
      }
      metadataRequests.push(text);
      return jsonResponse({
        panoId: text.includes("panoId=pano-2") ? "pano-2" : "pano-1",
        lat: 35.1,
        lng: 139.1,
        heading: 94.5,
        links: [{ panoId: "pano-2", heading: 90, text: "Main St" }]
      });
    }
  });

  const byCoordinates = await plugin.getPanoGraphByCoordinates({ lat: 35, lng: 139 });
  nowMs += 30_000;
  const byPanoId = await plugin.getPanoGraphByPanoId({ panoId: "pano-2" });
  const byPanoIdCached = await plugin.getPanoGraphByPanoId({ panoId: "pano-2" });

  assert.equal(sessionCalls, 1);
  assert.equal(byCoordinates.panoId, "pano-1");
  assert.equal(byCoordinates.location.lat, 35.1);
  assert.equal(byCoordinates.heading, 94.5);
  assert.deepEqual(byCoordinates.links, [{ panoId: "pano-2", heading: 90, text: "Main St" }]);
  assert.equal(byPanoId.panoId, "pano-2");
  assert.equal(byPanoIdCached.panoId, "pano-2");
  assert.equal(storedMetadata(root, "pano-2").panoId, "pano-2");
  assert.equal(metadataRequests.length, 2);
  assert.deepEqual(metadataRequests.map((url) => new URL(url).searchParams.get("session")), ["session-1", "session-1"]);
});

test("panoGraph_refreshesExpiredMapTilesSession", async () => {
  const root = tempOutputRoot();
  let nowMs = Date.parse("2026-06-17T00:00:00.000Z");
  let sessionCalls = 0;
  const metadataSessions: string[] = [];
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    now: () => new Date(nowMs),
    fetch: async (url) => {
      const text = String(url);
      if (text.includes("/createSession")) {
        sessionCalls += 1;
        return jsonResponse({ session: `session-${sessionCalls}`, expiry: String((nowMs + 120_000) / 1000) });
      }
      metadataSessions.push(new URL(text).searchParams.get("session") ?? "");
      return jsonResponse({ panoId: `pano-${metadataSessions.length}`, lat: 35, lng: 139, heading: 0, links: [] });
    }
  });

  await plugin.getPanoGraphByCoordinates({ lat: 35, lng: 139 });
  nowMs += 30_000;
  await plugin.getPanoGraphByPanoId({ panoId: "pano-1" });
  nowMs += 91_000;
  await plugin.getPanoGraphByPanoId({ panoId: "pano-2" });

  assert.equal(sessionCalls, 2);
  assert.deepEqual(metadataSessions, ["session-1", "session-2"]);
});

test("panoGraph_surfacesMapTilesApiErrors", async () => {
  const root = tempOutputRoot();
  const plugin = createGoogleStreetViewPlugin({
    config: configWithOutput(root),
    fetch: async (url) => {
      if (String(url).includes("/createSession")) return jsonResponse({ session: "session-1", expiry: "1780000000" });
      return new Response(JSON.stringify({ error: { message: "bad session" } }), {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" }
      });
    }
  });

  await assert.rejects(
    () => plugin.getPanoGraphByCoordinates({ lat: 35, lng: 139 }),
    /map tiles metadata request failed: HTTP 400 Bad Request/
  );
});
