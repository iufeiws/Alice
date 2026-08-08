import type { ImageRecognitionTarget } from "../../image-recognition/src/index.js";

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
  recognizeImage?(target: ImageRecognitionTarget): Promise<GoogleStreetViewImageRecognition>;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export type GoogleStreetViewByCoordinatesInput = {
  lat: number;
  lng: number;
  regionId?: string;
  reuseStoredForLocation?: boolean;
  recognizeImage?: boolean;
};

export type GoogleStreetViewRandomInput = {
  regionId?: string;
  reuseStoredForLocation?: boolean;
  recognizeImage?: boolean;
};

export type GoogleStreetViewImageRecognition = {
  text: string;
  provider: "multimodal_llm";
  model?: string;
  durationMs?: number;
  requestId?: string;
};

export type GoogleStreetViewMetadataByCoordinatesInput = {
  lat: number;
  lng: number;
};

export type GoogleStreetViewPanoGraphByCoordinatesInput = {
  lat: number;
  lng: number;
  radiusMeters?: number;
};

export type GoogleStreetViewPanoGraphByPanoIdInput = {
  panoId: string;
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
  metadataPath: string;
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
  metadata: GoogleStreetViewMetadataResponse | GoogleStreetViewPanoGraphMetadataResponse;
  imageRecognition?: GoogleStreetViewImageRecognition;
};

export type GoogleStreetViewPlugin = {
  id: "google_streetview";
  config: GoogleStreetViewPluginConfig;
  getMetadataByCoordinates(input: GoogleStreetViewMetadataByCoordinatesInput): Promise<GoogleStreetViewMetadataResult>;
  getPanoGraphByCoordinates(input: GoogleStreetViewPanoGraphByCoordinatesInput): Promise<GoogleStreetViewPanoGraphResult>;
  getPanoGraphByPanoId(input: GoogleStreetViewPanoGraphByPanoIdInput): Promise<GoogleStreetViewPanoGraphResult>;
  getStreetViewByCoordinates(input: GoogleStreetViewByCoordinatesInput): Promise<GoogleStreetViewResult>;
  getRandomStreetView(input?: GoogleStreetViewRandomInput): Promise<GoogleStreetViewResult>;
};

export type GoogleStreetViewMetadataResult = {
  requestedLocation: GoogleStreetViewLocation;
  location: GoogleStreetViewLocation;
  panoId?: string;
  metadata: GoogleStreetViewMetadataResponse;
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

export type GoogleStreetViewPanoGraphLink = {
  panoId: string;
  heading: number;
  text?: string;
};

export type GoogleStreetViewPanoGraphResult = {
  panoId: string;
  location: GoogleStreetViewLocation;
  heading: number;
  links: GoogleStreetViewPanoGraphLink[];
  metadata: GoogleStreetViewPanoGraphMetadataResponse;
};

export type GoogleStreetViewPanoGraphMetadataResponse = {
  panoId?: string;
  lat?: number;
  lng?: number;
  heading?: number;
  links?: Array<{
    panoId?: string;
    heading?: number;
    text?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};
