import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/tool-execution/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import {
  defaultWorldWandererPluginConfigPath,
  pathEntryFromPano,
  readWorldWandererConfig,
  readWorldWandererState,
  writeWorldWandererConfig,
  writeWorldWandererState
} from "../../../../contexts/world-wanderer/src/index.js";
import type {
  WorldWandererConfig,
  WorldWandererState
} from "../../../../contexts/world-wanderer/src/index.js";
import type { GoogleStreetViewPanoGraphMetadataResponse, GoogleStreetViewPlugin } from "../../../../channels/google-streetview/src/index.js";
import { sendImage, type PhotoSendDeps } from "../../photo/src/send-output.js";
import { locationToolText, panoramaTool, panoramaToolName } from "../profile.js";

export type LocationToolsDeps = {
  configPath?: string;
  dbPath: string;
  getGoogleStreetView(): Pick<GoogleStreetViewPlugin, "getPanoGraphByCoordinates" | "getPanoGraphByPanoId" | "getStreetViewByCoordinates">;
  now(): string;
  time?: CurrentTimeProvider;
  store?: PhotoSendDeps["store"];
  outputRouter?: PhotoSendDeps["outputRouter"];
  resolveOutputTarget?: ToolOutputTargetResolver;
  appendMessageLog?: PhotoSendDeps["appendMessageLog"];
};

export function createLocationTools(deps: LocationToolsDeps): ToolPlugin {
  return {
    id: "location",
    listTools() {
      return readWorldWandererConfig(deps.configPath).enabled ? [panoramaTool] : [];
    },
    async execute(call) {
      if (call.toolName !== panoramaToolName) return toolError(call, locationToolText.unknownTool(call.toolName));
      const config = readWorldWandererConfig(deps.configPath);
      if (!config.enabled) return toolError(call, locationToolText.unavailable);
      const action = call.input.action;
      if (action !== "current" && action !== "send" && action !== "teleport" && action !== "navigation") {
        return toolError(call, locationToolText.invalidAction);
      }
      if (action === "teleport" || action === "navigation") {
        const lat = call.input.lat;
        const lng = call.input.lng;
        if (lat === undefined) return toolError(call, locationToolText.missingLat);
        if (lng === undefined) return toolError(call, locationToolText.missingLng);
        if (!finiteNumberInRange(lat, -90, 90)) return toolError(call, locationToolText.invalidLat);
        if (!finiteNumberInRange(lng, -180, 180)) return toolError(call, locationToolText.invalidLng);
        return action === "teleport"
          ? executeTeleport(call, config, lat, lng)
          : executeNavigation(call, config, lat, lng);
      }
      return action === "send" ? executeSend(call, config) : executeCurrent(call, config);
    }
  };

  async function executeCurrent(call: ToolCall, config: WorldWandererConfig): Promise<ToolResult> {
    const state = readWorldWandererState(deps.dbPath, config);
    const googleStreetView = deps.getGoogleStreetView();
    const pano = state.panoId
      ? await googleStreetView.getPanoGraphByPanoId({ panoId: state.panoId })
      : await googleStreetView.getPanoGraphByCoordinates(state.location);
    const text = readableWorldWandererLocationText(pano.metadata);
    if (!text) return toolError(call, locationToolText.addressUnavailable);
    const streetView = await googleStreetView.getStreetViewByCoordinates({
      lat: pano.location.lat,
      lng: pano.location.lng,
      recognizeImage: true
    });
    if (!streetView.imageRecognition) throw new Error("google streetview image recognition returned no result");
    return {
      callId: call.id,
      ok: true,
      output: `${text}\n${streetView.imageRecognition.text}`
    };
  }

  async function executeSend(call: ToolCall, config: WorldWandererConfig): Promise<ToolResult> {
    const target = deps.resolveOutputTarget?.(call);
    if (!target) return toolError(call, locationToolText.noCurrentSession);
    if (!deps.store || !deps.outputRouter || !deps.time) return toolError(call, locationToolText.sendUnavailable);

    const state = readWorldWandererState(deps.dbPath, config);
    const googleStreetView = deps.getGoogleStreetView();
    const pano = state.panoId
      ? await googleStreetView.getPanoGraphByPanoId({ panoId: state.panoId })
      : await googleStreetView.getPanoGraphByCoordinates(state.location);
    const streetView = await googleStreetView.getStreetViewByCoordinates({
      lat: pano.location.lat,
      lng: pano.location.lng
    });
    await sendImage({
      store: deps.store,
      outputRouter: deps.outputRouter,
      appendMessageLog: deps.appendMessageLog
    }, deps.time, target, streetView.assetId);
    return { callId: call.id, ok: true, output: streetView.assetId };
  }

  async function executeTeleport(call: ToolCall, config: WorldWandererConfig, lat: number, lng: number): Promise<ToolResult> {
    const googleStreetView = deps.getGoogleStreetView();
    const pano = await googleStreetView.getPanoGraphByCoordinates({ lat, lng });
    const text = readableWorldWandererLocationText(pano.metadata);
    if (!text) return toolError(call, locationToolText.addressUnavailable);
    const entry = pathEntryFromPano({ pano, lastHeading: pano.heading, time: deps.now() });
    const state: WorldWandererState = {
      location: pano.location,
      lastHeading: entry.lastHeading,
      panoId: pano.panoId,
      pathStack: [entry]
    };
    writeWorldWandererState(deps.dbPath, state, config.recentHistoryLimit);
    const next = { ...readWorldWandererConfig(deps.configPath) };
    delete next.targetLocation;
    writeWorldWandererConfig(deps.configPath ?? defaultWorldWandererPluginConfigPath, next);
    return { callId: call.id, ok: true, output: text };
  }

  function executeNavigation(call: ToolCall, config: WorldWandererConfig, lat: number, lng: number): ToolResult {
    writeWorldWandererConfig(deps.configPath ?? defaultWorldWandererPluginConfigPath, { ...config, targetLocation: { lat, lng } });
    return { callId: call.id, ok: true, output: JSON.stringify({ lat, lng }) };
  }
}

export function readableWorldWandererLocationText(metadata: GoogleStreetViewPanoGraphMetadataResponse | undefined): string | undefined {
  const formattedAddress = metadata ? stringValue(metadata.formattedAddress) : undefined;
  if (formattedAddress) return withRecordDate(formattedAddress, metadata);

  const components = Array.isArray(metadata?.addressComponents)
    ? metadata.addressComponents.map(addressComponentName).filter((value): value is string => Boolean(value))
    : [];
  if (components.length > 0) return withRecordDate([...new Set(components)].join(", "), metadata);

  return undefined;
}

function finiteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function withRecordDate(text: string, metadata: GoogleStreetViewPanoGraphMetadataResponse | undefined): string {
  const date = metadata ? stringValue(metadata.date) : undefined;
  return date ? `${text}\nRecord date: ${date}` : text;
}

function addressComponentName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const component = value as Record<string, unknown>;
  return stringValue(component.longName)
    ?? stringValue(component.long_name)
    ?? stringValue(component.shortName)
    ?? stringValue(component.short_name);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
