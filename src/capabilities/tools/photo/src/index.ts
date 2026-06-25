import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { photoToolText, selfieTool } from "../profile.js";
import { createSelfieExecutor, type PhotoToolsDeps } from "./selfie-tool.js";

export { defaultPhotoPluginConfigPath, publicPhotoPluginConfig, readPhotoPluginConfig } from "./config.js";
export type { PhotoPluginConfig, PhotoPluginPublicConfig, SelfieGenerationMode } from "./config.js";
export type { PhotoToolTarget, PhotoToolsDeps, SelfieContext, SelfieExecutor, SelfieExecutorInput, SelfieExecutorResult } from "./selfie-tool.js";

export function createPhotoTools(deps: PhotoToolsDeps): ToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  const executeSelfie = createSelfieExecutor(deps, time, proxyUrl);

  return {
    id: "photo",
    listTools() {
      return [selfieTool];
    },
    async execute(call, executionContext) {
      try {
        if (call.toolName === "selfie") return await executeSelfie(call, executionContext);
        return { callId: call.id, ok: false, error: photoToolText.unknownTool(call.toolName) };
      } catch (error) {
        return { callId: call.id, ok: false, error: describeToolError(error) };
      }
    }
  };
}

function describeToolError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return [error.message, cause === undefined ? "" : photoToolText.errorCause(describeToolError(cause))].filter(Boolean).join("\n");
}
