import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import {
  readWorldWandererConfig,
  readWorldWandererState,
} from "../../../../contexts/world-wanderer/src/index.js";
import type { GoogleStreetViewPanoGraphMetadataResponse, GoogleStreetViewPlugin } from "../../../../channels/google-streetview/src/index.js";
import { checkLocationTool, checkLocationToolName, locationToolText } from "../profile.js";

export type LocationToolsDeps = {
  configPath?: string;
  dbPath: string;
  getGoogleStreetView(): Pick<GoogleStreetViewPlugin, "getPanoGraphByCoordinates" | "getPanoGraphByPanoId">;
  now?(): Date;
};

export function createLocationTools(deps: LocationToolsDeps): ToolPlugin {
  return {
    id: "location",
    listTools() {
      return readWorldWandererConfig(deps.configPath).enabled ? [checkLocationTool] : [];
    },
    async execute(call) {
      if (call.toolName !== checkLocationToolName) return toolError(call, locationToolText.unknownTool(call.toolName));
      const config = readWorldWandererConfig(deps.configPath);
      if (!config.enabled) return toolError(call, locationToolText.unavailable);
      const state = readWorldWandererState(deps.dbPath, config);
      const googleStreetView = deps.getGoogleStreetView();
      const pano = state.panoId
        ? await googleStreetView.getPanoGraphByPanoId({ panoId: state.panoId })
        : await googleStreetView.getPanoGraphByCoordinates(state.location);
      const text = readableWorldWandererLocationText(pano.metadata);
      return text ? { callId: call.id, ok: true, output: text } : toolError(call, locationToolText.addressUnavailable);
    }
  };
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
