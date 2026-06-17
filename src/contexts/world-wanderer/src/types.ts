import type {
  GoogleStreetViewLocation,
  GoogleStreetViewPanoGraphMetadataResponse,
  GoogleStreetViewPlugin
} from "../../../channels/google-streetview/src/index.js";

export type WorldWandererConfig = {
  enabled: boolean;
  speedMetersPerSecond: number;
  initialLocation: GoogleStreetViewLocation;
  initialHeading: number;
  recentHistoryLimit: number;
  maxPanosPerIdle: number;
  noveltyWeight: number;
  forwardWeight: number;
  roadContinuityWeight: number;
  uturnPenalty: number;
  loopPenalty: number;
  selectionTemperature: number;
};

export type WorldWandererPathEntry = {
  panoId: string;
  location: GoogleStreetViewLocation;
  heading: number;
};

export type WorldWandererState = {
  location: GoogleStreetViewLocation;
  lastHeading: number;
  lastRoadText?: string;
  metadata?: GoogleStreetViewPanoGraphMetadataResponse;
  metadataLocation?: GoogleStreetViewLocation;
  panoId?: string;
  recentPanoIds: string[];
  pathStack: WorldWandererPathEntry[];
  lastFailure?: {
    message: string;
    at: string;
  };
  updatedAt: string;
};

export type WorldWandererRuntime = {
  runIdleTransition(input: { delayMs: number }): Promise<WorldWandererState | undefined>;
  getState(): WorldWandererState;
};

export type WorldWandererDeps = {
  configPath?: string;
  statePath: string;
  googleStreetView: Pick<GoogleStreetViewPlugin, "getPanoGraphByCoordinates" | "getPanoGraphByPanoId">;
  now?(): Date;
  random?(): number;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export const defaultWorldWandererPluginConfigPath = "config/plugin/world-wanderer/config.json";
export const defaultWorldWandererInitialLocation: GoogleStreetViewLocation = {
  lat: 41.0086,
  lng: 28.9802
};
