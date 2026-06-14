const fs = await import("node:fs");
const path = await import("node:path");

export const defaultGoogleStreetViewPluginConfigPath = "config/plugin/google-streetview/config.json";
export const defaultGoogleStreetViewOutputDir = "assets/plugin/google-streetview";

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

type GoogleStreetViewSidecar = {
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

export function createGoogleStreetViewPlugin(deps: GoogleStreetViewPluginDeps = {}): GoogleStreetViewPlugin {
  const fetchImpl = deps.fetch ?? fetch;
  const random = deps.random ?? Math.random;

  return {
    id: "google_streetview",
    get config() {
      return runtimeConfig();
    },
    async getStreetViewByCoordinates(input) {
      const config = runtimeConfig();
      assertEnabled(config);
      const requestedLocation = normalizeLocation(input);
      const coordinateBucket = bucketForLocation(requestedLocation, config.coordinatePrecision);
      if (input.reuseStoredForLocation) {
        const stored = pickStoredResult(config, coordinateBucket, random);
        if (stored) {
          deps.appendLog?.("info", `google streetview reuse hit: bucket=${coordinateBucket} asset=${stored.assetId}`);
          return stored;
        }
      }
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
        if (input.reuseStoredForLocation) {
          const stored = pickStoredResult(config, coordinateBucket, random);
          if (stored) {
            deps.appendLog?.("info", `google streetview random reuse hit: region=${region.id} bucket=${coordinateBucket} asset=${stored.assetId}`);
            return stored;
          }
        }
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
}

export function readGoogleStreetViewPluginConfig(
  configPath = defaultGoogleStreetViewPluginConfigPath,
  defaults: Partial<GoogleStreetViewPluginConfig> = {},
  env: Record<string, string | undefined> = process.env
): GoogleStreetViewPluginConfig {
  const resolved = path.resolve(configPath);
  const parsed = fs.existsSync(resolved) ? parseJsonObject(fs.readFileSync(resolved, "utf8")) : {};
  return normalizeGoogleStreetViewPluginConfig(parsed, { ...envDefaults(env), ...defaults });
}

export function publicGoogleStreetViewPluginConfig(config: GoogleStreetViewPluginConfig): GoogleStreetViewPluginPublicConfig {
  const { apiKey, ...publicConfig } = config;
  return {
    ...publicConfig,
    apiKeySet: Boolean(apiKey)
  };
}

export function normalizeGoogleStreetViewPluginConfig(
  parsed: Record<string, unknown>,
  defaults: Partial<GoogleStreetViewPluginConfig> = {}
): GoogleStreetViewPluginConfig {
  return {
    enabled: booleanValue(parsed.enabled, defaults.enabled ?? true),
    apiKey: stringValue(parsed.apiKey, defaults.apiKey),
    imageSize: stringValue(parsed.imageSize, defaults.imageSize ?? "640x640")!,
    heading: numberValue(parsed.heading, defaults.heading ?? 0),
    pitch: numberValue(parsed.pitch, defaults.pitch ?? 0),
    fov: numberValue(parsed.fov, defaults.fov ?? 90),
    initialRadiusMeters: numberValue(parsed.initialRadiusMeters, defaults.initialRadiusMeters ?? 50),
    radiusExpansionFactor: numberValue(parsed.radiusExpansionFactor, defaults.radiusExpansionFactor ?? 2),
    maxRadiusMeters: numberValue(parsed.maxRadiusMeters, defaults.maxRadiusMeters ?? 1000),
    randomAttempts: numberValue(parsed.randomAttempts, defaults.randomAttempts ?? 8),
    coordinatePrecision: Math.trunc(numberValue(parsed.coordinatePrecision, defaults.coordinatePrecision ?? 5)),
    outputDir: stringValue(parsed.outputDir, defaults.outputDir ?? defaultGoogleStreetViewOutputDir)!,
    regions: regionListValue(parsed.regions, defaults.regions ?? [])
  };
}

export function validateGoogleStreetViewPluginConfig(config: GoogleStreetViewPluginConfig): string | undefined {
  if (!config.outputDir || !isAllowedOutputDir(config.outputDir)) return "invalid_output_dir";
  if (!/^\d+x\d+$/.test(config.imageSize)) return "invalid_image_size";
  if (config.initialRadiusMeters < 0 || config.initialRadiusMeters > 50_000) return "invalid_initial_radius";
  if (config.radiusExpansionFactor <= 1 || config.radiusExpansionFactor > 10) return "invalid_radius_expansion_factor";
  if (config.maxRadiusMeters < config.initialRadiusMeters || config.maxRadiusMeters > 100_000) return "invalid_max_radius";
  if (config.randomAttempts < 1 || config.randomAttempts > 100) return "invalid_random_attempts";
  if (config.coordinatePrecision < 0 || config.coordinatePrecision > 7) return "invalid_coordinate_precision";
  if (config.fov < 10 || config.fov > 120) return "invalid_fov";
  if (config.pitch < -90 || config.pitch > 90) return "invalid_pitch";
  for (const region of config.regions) {
    if (!region.id) return "invalid_region";
    if (region.bounds.north < region.bounds.south) return "invalid_region_bounds";
    if (region.bounds.north > 90 || region.bounds.south < -90 || region.bounds.east > 180 || region.bounds.west < -180) return "invalid_region_bounds";
  }
  return undefined;
}

async function fetchAndStoreStreetView(input: {
  config: GoogleStreetViewPluginConfig;
  requestedLocation: GoogleStreetViewLocation;
  regionId?: string;
  coordinateBucket: string;
  fetchImpl: typeof fetch;
  now(): Date;
  appendLog?: GoogleStreetViewPluginDeps["appendLog"];
}): Promise<GoogleStreetViewResult> {
  if (!input.config.apiKey) throw new Error("google streetview API key is not configured");
  const metadata = await findAvailableMetadata(input);
  const actualLocation = normalizeMetadataLocation(metadata, input.requestedLocation);
  const now = input.now();
  const month = now.toISOString().slice(0, 7);
  const outputDir = path.resolve(input.config.outputDir, month);
  fs.mkdirSync(outputDir, { recursive: true });
  const fileBase = `${safeFilePart(input.coordinateBucket)}_${formatFileDateTime(now.toISOString())}`;
  const filePath = path.join(outputDir, `${fileBase}.jpg`);
  const sidecarPath = path.join(outputDir, `${fileBase}.json`);
  const imageUrl = staticStreetViewUrl(input.config, actualLocation);
  const imageResponse = await input.fetchImpl(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`google streetview image request failed: HTTP ${imageResponse.status} ${imageResponse.statusText}`);
  }
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (!bytes.length) throw new Error("google streetview image request returned empty body");
  fs.writeFileSync(filePath, bytes);

  const assetId = assetIdForPath(filePath);
  const sidecar: GoogleStreetViewSidecar = {
    assetId,
    filePath,
    sidecarPath,
    coordinateBucket: input.coordinateBucket,
    requestedLocation: input.requestedLocation,
    location: actualLocation,
    regionId: input.regionId,
    panoId: typeof metadata.pano_id === "string" ? metadata.pano_id : undefined,
    heading: input.config.heading,
    pitch: input.config.pitch,
    fov: input.config.fov,
    metadata,
    createdAt: now.toISOString()
  };
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  input.appendLog?.("info", `google streetview saved: asset=${assetId} bucket=${input.coordinateBucket}`);
  return sidecarToResult(sidecar, false);
}

async function findAvailableMetadata(input: {
  config: GoogleStreetViewPluginConfig;
  requestedLocation: GoogleStreetViewLocation;
  fetchImpl: typeof fetch;
}): Promise<GoogleStreetViewMetadataResponse> {
  let radius = input.config.initialRadiusMeters;
  const maxRadius = input.config.maxRadiusMeters;
  while (radius <= maxRadius) {
    const response = await input.fetchImpl(metadataUrl(input.config, input.requestedLocation, radius));
    if (!response.ok) throw new Error(`google streetview metadata request failed: HTTP ${response.status} ${response.statusText}`);
    const metadata = await response.json() as GoogleStreetViewMetadataResponse;
    if (metadata.status === "OK") return metadata;
    if (radius === maxRadius) break;
    radius = Math.min(maxRadius, Math.max(radius + 1, Math.ceil(radius * input.config.radiusExpansionFactor)));
  }
  throw new Error(`google streetview metadata returned no imagery near ${formatLocation(input.requestedLocation)}`);
}

function pickStoredResult(config: GoogleStreetViewPluginConfig, coordinateBucket: string, random: () => number): GoogleStreetViewResult | undefined {
  const sidecars = listStoredSidecars(config.outputDir)
    .filter((entry) => entry.coordinateBucket === coordinateBucket && fs.existsSync(entry.filePath));
  if (!sidecars.length) return undefined;
  return sidecarToResult(sidecars[Math.floor(random() * sidecars.length)]!, true);
}

function listStoredSidecars(outputDir: string): GoogleStreetViewSidecar[] {
  const root = path.resolve(outputDir);
  if (!fs.existsSync(root)) return [];
  const entries: GoogleStreetViewSidecar[] = [];
  for (const filePath of walkFiles(root)) {
    if (!filePath.endsWith(".json")) continue;
    try {
      const parsed = parseJsonObject(fs.readFileSync(filePath, "utf8")) as Partial<GoogleStreetViewSidecar>;
      if (typeof parsed.assetId !== "string" || typeof parsed.filePath !== "string" || typeof parsed.coordinateBucket !== "string") continue;
      entries.push({
        assetId: parsed.assetId,
        filePath: parsed.filePath,
        sidecarPath: filePath,
        coordinateBucket: parsed.coordinateBucket,
        requestedLocation: normalizeLocation(parsed.requestedLocation),
        location: normalizeLocation(parsed.location),
        regionId: typeof parsed.regionId === "string" ? parsed.regionId : undefined,
        panoId: typeof parsed.panoId === "string" ? parsed.panoId : undefined,
        heading: numberValue(parsed.heading, 0),
        pitch: numberValue(parsed.pitch, 0),
        fov: numberValue(parsed.fov, 90),
        metadata: parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata as GoogleStreetViewMetadataResponse : {},
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
      });
    } catch {
      continue;
    }
  }
  return entries;
}

function sidecarToResult(sidecar: GoogleStreetViewSidecar, reused: boolean): GoogleStreetViewResult {
  return {
    assetId: sidecar.assetId,
    filePath: sidecar.filePath,
    sidecarPath: sidecar.sidecarPath ?? sidecar.filePath.replace(/\.[^.]+$/, ".json"),
    location: sidecar.location,
    requestedLocation: sidecar.requestedLocation,
    coordinateBucket: sidecar.coordinateBucket,
    regionId: sidecar.regionId,
    panoId: sidecar.panoId,
    heading: sidecar.heading,
    pitch: sidecar.pitch,
    fov: sidecar.fov,
    source: reused ? "stored" : "google_streetview_static",
    reused,
    metadata: sidecar.metadata
  };
}

function metadataUrl(config: GoogleStreetViewPluginConfig, location: GoogleStreetViewLocation, radius: number): string {
  const url = new URL("https://maps.googleapis.com/maps/api/streetview/metadata");
  url.searchParams.set("location", formatLocation(location));
  url.searchParams.set("radius", String(radius));
  url.searchParams.set("key", config.apiKey ?? "");
  return url.toString();
}

function staticStreetViewUrl(config: GoogleStreetViewPluginConfig, location: GoogleStreetViewLocation): string {
  const url = new URL("https://maps.googleapis.com/maps/api/streetview");
  url.searchParams.set("size", config.imageSize);
  url.searchParams.set("location", formatLocation(location));
  url.searchParams.set("heading", String(config.heading));
  url.searchParams.set("pitch", String(config.pitch));
  url.searchParams.set("fov", String(config.fov));
  url.searchParams.set("key", config.apiKey ?? "");
  return url.toString();
}

function assertEnabled(config: GoogleStreetViewPluginConfig): void {
  const error = validateGoogleStreetViewPluginConfig(config);
  if (error) throw new Error(`invalid google streetview config: ${error}`);
  if (!config.enabled) throw new Error("google streetview plugin is disabled");
}

function envDefaults(env: Record<string, string | undefined>): Partial<GoogleStreetViewPluginConfig> {
  return {
    apiKey: env.GOOGLE_STREETVIEW_API_KEY
  };
}

function findRegion(config: GoogleStreetViewPluginConfig, regionId: string): GoogleStreetViewRegion {
  const region = config.regions.find((entry) => entry.id === regionId);
  if (!region) throw new Error(`unknown google streetview region: ${regionId}`);
  return region;
}

function randomLocationInRegion(region: GoogleStreetViewRegion, random: () => number): GoogleStreetViewLocation {
  return {
    lat: region.bounds.south + random() * (region.bounds.north - region.bounds.south),
    lng: region.bounds.west + random() * (region.bounds.east - region.bounds.west)
  };
}

export function bucketForLocation(location: GoogleStreetViewLocation, precision: number): string {
  const factor = 10 ** precision;
  const lat = Math.round(location.lat * factor) / factor;
  const lng = Math.round(location.lng * factor) / factor;
  return `${lat.toFixed(precision)},${lng.toFixed(precision)}`;
}

function normalizeLocation(input: unknown): GoogleStreetViewLocation {
  if (!input || typeof input !== "object") throw new Error("location is required");
  const value = input as { lat?: unknown; lng?: unknown };
  const lat = numberValue(value.lat, Number.NaN);
  const lng = numberValue(value.lng, Number.NaN);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error("invalid latitude");
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error("invalid longitude");
  return { lat, lng };
}

function normalizeMetadataLocation(metadata: GoogleStreetViewMetadataResponse, fallback: GoogleStreetViewLocation): GoogleStreetViewLocation {
  const lat = typeof metadata.location?.lat === "number" ? metadata.location.lat : fallback.lat;
  const lng = typeof metadata.location?.lng === "number" ? metadata.location.lng : fallback.lng;
  return normalizeLocation({ lat, lng });
}

function formatLocation(location: GoogleStreetViewLocation): string {
  return `${location.lat},${location.lng}`;
}

function assetIdForPath(filePath: string): string {
  const relative = path.relative(path.resolve("assets"), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("google streetview asset path is outside assets");
  return relative.split(path.sep).join("/");
}

function isAllowedOutputDir(outputDir: string): boolean {
  const resolved = path.resolve(outputDir);
  const allowedRoot = path.resolve(defaultGoogleStreetViewOutputDir);
  const generatedRoot = path.resolve("assets/generated");
  const relative = path.relative(allowedRoot, resolved);
  const generatedRelative = path.relative(generatedRoot, resolved);
  return (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    && !(generatedRelative === "" || (!generatedRelative.startsWith("..") && !path.isAbsolute(generatedRelative)));
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function regionListValue(value: unknown, fallback: GoogleStreetViewRegion[]): GoogleStreetViewRegion[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((entry) => normalizeRegion(entry)).filter((entry): entry is GoogleStreetViewRegion => Boolean(entry));
}

function normalizeRegion(value: unknown): GoogleStreetViewRegion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { id?: unknown; label?: unknown; bounds?: unknown };
  const id = stringValue(entry.id);
  if (!id || !entry.bounds || typeof entry.bounds !== "object") return undefined;
  const bounds = entry.bounds as Record<string, unknown>;
  return {
    id,
    label: stringValue(entry.label),
    bounds: {
      north: numberValue(bounds.north, Number.NaN),
      south: numberValue(bounds.south, Number.NaN),
      east: numberValue(bounds.east, Number.NaN),
      west: numberValue(bounds.west, Number.NaN)
    }
  };
}

function* walkFiles(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function formatFileDateTime(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
