import type { ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import {
  readWorldWandererConfig,
  readWorldWandererState,
} from "../../../../contexts/world-wanderer/src/index.js";
import type { GoogleStreetViewPanoGraphMetadataResponse, GoogleStreetViewPlugin } from "../../../../channels/google-streetview/src/index.js";

export type LocationToolsDeps = {
  configPath?: string;
  dbPath: string;
  getGoogleStreetView(): Pick<GoogleStreetViewPlugin, "getPanoGraphByCoordinates" | "getPanoGraphByPanoId">;
  now?(): Date;
};

const checkLocationToolName = "check_location";

const checkLocationTool: ToolDefinition = {
  name: checkLocationToolName,
  description: "当前记录的位置",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export function createLocationTools(deps: LocationToolsDeps): ToolPlugin {
  return {
    id: "location",
    listTools() {
      return readWorldWandererConfig(deps.configPath).enabled ? [checkLocationTool] : [];
    },
    async execute(call) {
      if (call.toolName !== checkLocationToolName) return toolError(call, `Unknown location tool: ${call.toolName}`);
      const config = readWorldWandererConfig(deps.configPath);
      if (!config.enabled) return toolError(call, "location_unavailable");
      const state = readWorldWandererState(deps.dbPath, config);
      const googleStreetView = deps.getGoogleStreetView();
      const pano = state.panoId
        ? await googleStreetView.getPanoGraphByPanoId({ panoId: state.panoId })
        : await googleStreetView.getPanoGraphByCoordinates(state.location);
      const text = readableWorldWandererLocationText(pano.metadata);
      return text ? { callId: call.id, ok: true, output: text } : toolError(call, "location_address_unavailable");
    }
  };
}

export function readableWorldWandererLocationText(metadata: GoogleStreetViewPanoGraphMetadataResponse | undefined): string | undefined {
  const formattedAddress = metadata ? stringValue(metadata.formattedAddress) : undefined;
  if (formattedAddress) return formattedAddress;

  const components = Array.isArray(metadata?.addressComponents)
    ? metadata.addressComponents.map(addressComponentName).filter((value): value is string => Boolean(value))
    : [];
  if (components.length > 0) return [...new Set(components)].join(", ");

  return undefined;
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
