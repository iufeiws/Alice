import type { ToolDefinition } from "../../../contexts/tool-execution/src/index.js";

export const panoramaToolName = "Panorama";

export const panoramaTool: ToolDefinition = {
  name: panoramaToolName,
  passRenderText: true,
  description: "控制alice的当前位置, selfie时会是当前所在位置的场景。action=current 查看当前所在历史影像的的描述(会拉取影像文件); action=send 将当前 pano 图片发送给<user>(会拉取影像文件)；action=teleport 按经纬度传送到最近 pano、重置轨迹并清除导航目标；action=navigation 将 World Wanderer 的导航目标设为指定经纬度。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["current", "send", "teleport", "navigation"] },
      lat: { type: "number", minimum: -90, maximum: 90 },
      lng: { type: "number", minimum: -180, maximum: 180 }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export const locationToolText = {
  unknownTool: (toolName: string) => `Unknown location tool: ${toolName}`,
  unavailable: "location_unavailable",
  addressUnavailable: "location_address_unavailable",
  noCurrentSession: "no_current_session",
  sendUnavailable: "location_send_unavailable",
  invalidAction: "invalid_action",
  missingLat: "missing_lat",
  missingLng: "missing_lng",
  invalidLat: "invalid_lat",
  invalidLng: "invalid_lng"
};
