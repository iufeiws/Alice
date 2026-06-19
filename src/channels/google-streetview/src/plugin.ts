import type {
  GoogleStreetViewPlugin,
  GoogleStreetViewPluginConfig,
  GoogleStreetViewPluginDeps
} from "./types.js";
import {
  envDefaults,
  normalizeGoogleStreetViewPluginConfig,
  readGoogleStreetViewPluginConfig,
  validateGoogleStreetViewPluginConfig
} from "./config.js";
import {
  bucketForLocation,
  findRegion,
  normalizeMetadataLocation,
  normalizeLocation,
  randomLocationInRegion
} from "./geo.js";
import {
  createStreetViewMapTilesSession,
  findAvailableMetadata,
  getPanoGraphByCoordinates,
  getPanoGraphByPanoId,
  normalizePanoGraphMetadata,
  type GoogleStreetViewMapTilesSession
} from "./client.js";
import { errorMessage } from "./internal.js";
import { fetchAndStoreStreetView, readPanoGraphMetadataCache, storeStreetViewMetadata } from "./storage.js";

export function createGoogleStreetViewPlugin(deps: GoogleStreetViewPluginDeps = {}): GoogleStreetViewPlugin {
  const fetchImpl = deps.fetch ?? fetch;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());
  let mapTilesSession: GoogleStreetViewMapTilesSession | undefined;

  return {
    id: "google_streetview",
    get config() {
      return runtimeConfig();
    },
    async getMetadataByCoordinates(input) {
      const config = runtimeConfig();
      assertEnabled(config);
      const requestedLocation = normalizeLocation(input);
      const metadata = await findAvailableMetadata({
        config,
        requestedLocation,
        fetchImpl
      });
      const location = normalizeMetadataLocation(metadata, requestedLocation);
      storeStreetViewMetadata(config, metadata);
      return {
        requestedLocation,
        location,
        panoId: typeof metadata.pano_id === "string" ? metadata.pano_id : undefined,
        metadata
      };
    },
    async getPanoGraphByCoordinates(input) {
      const config = runtimeConfig();
      assertEnabled(config);
      const requestedLocation = normalizeLocation(input);
      const session = await streetViewMapTilesSession(config);
      const result = await getPanoGraphByCoordinates({
        config,
        sessionToken: session.token,
        requestedLocation,
        radiusMeters: input.radiusMeters,
        fetchImpl
      });
      storeStreetViewMetadata(config, result.metadata);
      return result;
    },
    async getPanoGraphByPanoId(input) {
      const config = runtimeConfig();
      assertEnabled(config);
      const panoId = typeof input.panoId === "string" && input.panoId.trim() ? input.panoId.trim() : undefined;
      if (!panoId) throw new Error("panoId is required");
      const cached = readPanoGraphMetadataCache(config, panoId);
      if (cached) return normalizePanoGraphMetadata(cached);
      const session = await streetViewMapTilesSession(config);
      const result = await getPanoGraphByPanoId({
        config,
        sessionToken: session.token,
        panoId,
        fetchImpl
      });
      storeStreetViewMetadata(config, result.metadata);
      return result;
    },
    async getStreetViewByCoordinates(input) {
      const config = runtimeConfig();
      assertEnabled(config);
      const requestedLocation = normalizeLocation(input);
      const coordinateBucket = bucketForLocation(requestedLocation, config.coordinatePrecision);
      return fetchAndStoreStreetView({
        config,
        requestedLocation,
        regionId: input.regionId,
        coordinateBucket,
        fetchImpl,
        now: deps.now ?? (() => new Date()),
        appendLog: deps.appendLog
      });
    },
    async getRandomStreetView(input = {}) {
      const config = runtimeConfig();
      assertEnabled(config);
      const regions = input.regionId ? [findRegion(config, input.regionId)] : config.regions;
      if (!regions.length) throw new Error("google streetview regions are not configured");

      let lastError: unknown;
      const attempts = Math.max(1, config.randomAttempts);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const region = regions[Math.floor(random() * regions.length)]!;
        const requestedLocation = randomLocationInRegion(region, random);
        const coordinateBucket = bucketForLocation(requestedLocation, config.coordinatePrecision);
        try {
          return await fetchAndStoreStreetView({
            config,
            requestedLocation,
            regionId: region.id,
            coordinateBucket,
            fetchImpl,
            now: deps.now ?? (() => new Date()),
            appendLog: deps.appendLog
          });
        } catch (error) {
          lastError = error;
          deps.appendLog?.("warn", `google streetview random attempt failed: attempt=${attempt + 1}/${attempts} region=${region.id} error=${errorMessage(error)}`);
        }
      }
      throw new Error(`google streetview random lookup failed after ${attempts} attempts: ${errorMessage(lastError)}`);
    }
  };

  function runtimeConfig(): GoogleStreetViewPluginConfig {
    const defaults = normalizeGoogleStreetViewPluginConfig(deps.config ?? {}, envDefaults(deps.env ?? process.env));
    return deps.configPath
      ? readGoogleStreetViewPluginConfig(deps.configPath, defaults, deps.env)
      : defaults;
  }

  async function streetViewMapTilesSession(config: GoogleStreetViewPluginConfig): Promise<GoogleStreetViewMapTilesSession> {
    const refreshAt = (mapTilesSession?.expiryMs ?? 0) - 60_000;
    if (mapTilesSession && mapTilesSession.apiKey === config.apiKey && now().getTime() < refreshAt) return mapTilesSession;
    mapTilesSession = await createStreetViewMapTilesSession({ config, fetchImpl });
    return mapTilesSession;
  }
}

function assertEnabled(config: GoogleStreetViewPluginConfig): void {
  const error = validateGoogleStreetViewPluginConfig(config);
  if (error) throw new Error(`invalid google streetview config: ${error}`);
  if (!config.enabled) throw new Error("google streetview plugin is disabled");
}
