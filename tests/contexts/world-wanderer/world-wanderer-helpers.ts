import { after } from "node:test";
import type { GoogleStreetViewPanoGraphResult } from "../../../src/channels/google-streetview/src/index.js";
import {
  readWorldWandererConfig,
  type WorldWandererConfig,
  type WorldWandererState
} from "../../../src/contexts/world-wanderer/src/index.js";

export const fs = await import("node:fs");
export const os = await import("node:os");
export const path = await import("node:path");

const tempRoots: string[] = [];
const missingDefaultConfigPath = path.join(os.tmpdir(), `alice-world-wanderer-missing-config-${process.pid}.json`);

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

export function worldWandererPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-world-wanderer-"));
  tempRoots.push(root);
  return {
    root,
    configPath: path.join(root, "config.json"),
    dbPath: path.join(root, "alice.sqlite")
  };
}

export function worldWandererConfig(patch: Partial<WorldWandererConfig> = {}): WorldWandererConfig {
  return {
    ...readWorldWandererConfig(missingDefaultConfigPath),
    enabled: true,
    ...patch
  };
}

export function pano(
  panoId: string,
  lat: number,
  lng: number,
  links: GoogleStreetViewPanoGraphResult["links"],
  heading = 0
): GoogleStreetViewPanoGraphResult {
  return {
    panoId,
    location: { lat, lng },
    heading,
    links,
    metadata: { panoId, lat, lng, heading, links }
  };
}

export function chainGraph(count: number): Map<string, GoogleStreetViewPanoGraphResult> {
  const graph = new Map<string, GoogleStreetViewPanoGraphResult>();
  for (let index = 0; index < count; index += 1) {
    const current = `p${index}`;
    const next = index + 1 < count ? `p${index + 1}` : undefined;
    graph.set(current, pano(current, 41, 29 + index * 0.001, next ? [{ panoId: next, heading: 90, text: "Road" }] : []));
  }
  return graph;
}

export function graphGoogleStreetView(
  graph: Map<string, GoogleStreetViewPanoGraphResult>,
  coordinateCalls: Array<{ lat: number; lng: number }> = []
) {
  return {
    async getPanoGraphByCoordinates(input: { lat: number; lng: number }) {
      coordinateCalls.push(input);
      const first = graph.values().next().value as GoogleStreetViewPanoGraphResult | undefined;
      if (!first) throw new Error("missing pano");
      return first;
    },
    async getPanoGraphByPanoId(input: { panoId: string }) {
      const result = graph.get(input.panoId);
      if (!result) throw new Error("missing pano");
      return result;
    }
  };
}

export function pathPanoIds(state: Pick<WorldWandererState, "pathStack">): string[] {
  return state.pathStack.map((entry) => entry.panoId);
}
