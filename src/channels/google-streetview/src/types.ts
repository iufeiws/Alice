export type GoogleStreetViewBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type GoogleStreetViewRegion = {
  id: string;
  label?: string;
  bounds: GoogleStreetViewBounds;
};

export type GoogleStreetViewPluginConfig = {
  enabled: boolean;
  apiKey?: string;
  imageSize: string;
  heading: number;
  pitch: number;
  fov: number;
  initialRadiusMeters: number;
  radiusExpansionFactor: number;
  maxRadiusMeters: number;
  randomAttempts: number;
  coordinatePrecision: number;
  outputDir: string;
  regions: GoogleStreetViewRegion[];
};

export type GoogleStreetViewPluginPublicConfig = Omit<GoogleStreetViewPluginConfig, "apiKey"> & {
  apiKeySet: boolean;
};

export type GoogleStreetViewPluginDeps = {
  configPath?: string;
  config?: Partial<GoogleStreetViewPluginConfig>;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?(): Date;
  random?(): number;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export type GoogleStreetViewByCoordinatesInput = {
  lat: number;
  lng: number;
  regionId?: string;
  reuseStoredForLocation?: boolean;
};

export type GoogleStreetViewRandomInput = {
  regionId?: string;
  reuseStoredForLocation?: boolean;
};

export type GoogleStreetViewLocation = {
  lat: number;
  lng: number;
};

export type GoogleStreetViewStoredSource = "stored";
export type GoogleStreetViewRemoteSource = "google_streetview_static";

export type GoogleStreetViewResult = {
  assetId: string;
  filePath: string;
  sidecarPath: string;
  location: GoogleStreetViewLocation;
  requestedLocation: GoogleStreetViewLocation;
  coordinateBucket: string;
  regionId?: string;
  panoId?: string;
  heading: number;
  pitch: number;
  fov: number;
  source: GoogleStreetViewStoredSource | GoogleStreetViewRemoteSource;
  reused: boolean;
  metadata: GoogleStreetViewMetadataResponse;
};

export type GoogleStreetViewPlugin = {
  id: "google_streetview";
  config: GoogleStreetViewPluginConfig;
  getStreetViewByCoordinates(input: GoogleStreetViewByCoordinatesInput): Promise<GoogleStreetViewResult>;
  getRandomStreetView(input?: GoogleStreetViewRandomInput): Promise<GoogleStreetViewResult>;
};

export type GoogleStreetViewMetadataResponse = {
  status?: string;
  copyright?: string;
  date?: string;
  pano_id?: string;
  location?: {
    lat?: number;
    lng?: number;
  };
  [key: string]: unknown;
};

export type GoogleStreetViewSidecar = {
  assetId: string;
  filePath: string;
  sidecarPath?: string;
  coordinateBucket: string;
  requestedLocation: GoogleStreetViewLocation;
  location: GoogleStreetViewLocation;
  regionId?: string;
  panoId?: string;
  heading: number;
  pitch: number;
  fov: number;
  metadata: GoogleStreetViewMetadataResponse;
  createdAt: string;
};
