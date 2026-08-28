import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import { executeRegisteredTool, getRegisteredToolDefinition, type ToolExecutionContext, type ToolResult } from "../../../tool-execution/src/index.js";
import type { AgentEvent } from "../contracts/agent-contracts.js";

export type AgentLoopToolExecutionOptions = {
  registryName?: string;
  context?: ToolExecutionContext;
  transformInput?(toolName: string, input: Record<string, unknown>): Record<string, unknown>;
};

export type AgentLoopPromptToolRequest = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  requester?: AgentEvent["source"];
  externalSession?: AgentEvent["externalSession"];
};

export async function runPromptToolRequest(
  call: AgentLoopPromptToolRequest,
  options: AgentLoopToolExecutionOptions = {}
): Promise<ToolResult> {
  return executeRegisteredTool(options.registryName ?? "default", {
    ...call,
    input: options.transformInput?.(call.toolName, call.input) ?? call.input
  }, options.context);
}

export function formatAgentLoopToolMessageContent(result: ToolResult, runtime: PromptContextRuntime | undefined, toolName?: string): string {
  if (!runtime) throw new Error("prompt_context_runtime_required");
  const passRenderText = toolName !== undefined && getRegisteredToolDefinition("default", toolName)?.passRenderText === true;
  if (!result.ok && typeof result.output === "string") return passRenderText ? runtime.renderText(result.output) : result.output;
  if (!result.ok) return result.error ? `error: ${passRenderText ? runtime.renderText(result.error) : result.error}` : "error";
  if (typeof result.output === "string") return passRenderText ? runtime.renderText(result.output) : result.output;
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  return JSON.stringify(result.output);
}
