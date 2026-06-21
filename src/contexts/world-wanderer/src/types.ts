import type {
  GoogleStreetViewLocation,
  GoogleStreetViewPlugin
} from "../../../channels/google-streetview/src/index.js";

export type WorldWandererConfig = {
  enabled: boolean;
  libraryPrompt: string;
  mapsJavaScriptApiKey: string;
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
  time: string;
  panoId: string;
  lat: number;
  lng: number;
  lastHeading: number;
};

export type WorldWandererState = {
  location: GoogleStreetViewLocation;
  lastHeading: number;
  panoId?: string;
  pathStack: WorldWandererPathEntry[];
};

export type WorldWandererRuntime = {
  isEnabled(): boolean;
  runIdleTransition(input: { delayMs: number }): Promise<WorldWandererState | undefined>;
  getState(): WorldWandererState;
};

export type WorldWandererDeps = {
  configPath?: string;
  dbPath: string;
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
