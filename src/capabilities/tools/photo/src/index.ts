import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { createSelfieExecutor, selfieTool, type PhotoToolsDeps } from "./selfie-tool.js";

export { defaultPhotoPluginConfigPath, publicPhotoPluginConfig, readPhotoPluginConfig } from "./config.js";
export type { PhotoPluginConfig, PhotoPluginPublicConfig, SelfieGenerationMode } from "./config.js";
export type { PhotoToolTarget, PhotoToolsDeps, SelfieAspectRatio, SelfieContext, SelfieExecutor, SelfieExecutorInput, SelfieExecutorResult } from "./selfie-tool.js";

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
        return { callId: call.id, ok: false, error: `Unknown photo tool: ${call.toolName}` };
      } catch (error) {
        return { callId: call.id, ok: false, error: describeToolError(error) };
      }
    }
  };
}

function describeToolError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return [error.message, cause === undefined ? "" : `cause: ${describeToolError(cause)}`].filter(Boolean).join("\n");
}
