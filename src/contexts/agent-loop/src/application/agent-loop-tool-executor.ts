import type { LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import type { AgentEvent, ToolCall, ToolExecutionContext, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";

export type AgentLoopToolExecutor = {
  toolMap: Map<string, ToolPlugin>;
  executePreparedToolCall(call: ToolCall): Promise<ToolResult>;
  executeToolCall(call: ToolCall, options?: AgentLoopToolExecutionOptions): Promise<ToolResult>;
  executeLLMToolCall(call: LLMToolCall, options?: AgentLoopToolExecutionOptions): Promise<AgentLoopExecutedToolCall>;
};

export type AgentLoopToolExecutionOptions = {
  variables?: PromptContextRuntime;
  agentLoopRunSeq?: number;
  llmSessionId?: number;
  llmCapabilities?: ToolExecutionContext["llmCapabilities"];
  transformInput?(toolName: string, input: Record<string, unknown>): Record<string, unknown>;
};

export type AgentLoopExecutedToolCall = {
  result: ToolResult;
  message: {
    role: "tool";
    toolCallId: string;
    name: string;
    content: string;
  };
};

export type AgentLoopPromptToolRequest = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  requester?: AgentEvent["source"];
  externalSession?: AgentEvent["externalSession"];
};

export function createAgentLoopToolExecutor(input: {
  event: AgentEvent;
  toolPlugins: ToolPlugin[];
  getLastCompletedToolName?(): string | undefined;
  setLastCompletedToolName?(name: string): void;
}): AgentLoopToolExecutor {
  const toolMap = buildAgentLoopToolMap(input.toolPlugins);

  async function executePreparedToolCall(call: ToolCall): Promise<ToolResult> {
    const result = await executePreparedAgentLoopToolCall(toolMap, call, {
      lastCompletedToolName: input.getLastCompletedToolName?.()
    });
    input.setLastCompletedToolName?.(call.toolName);
    return result;
  }

  async function executeToolCall(call: ToolCall, options: AgentLoopToolExecutionOptions = {}): Promise<ToolResult> {
    const preparedCall = {
      id: call.id,
      toolName: call.toolName,
      input: options.transformInput?.(call.toolName, call.input) ?? call.input,
      requester: input.event.source,
      externalSession: input.event.externalSession
    };
    const result = await executePreparedAgentLoopToolCall(toolMap, preparedCall, {
      lastCompletedToolName: input.getLastCompletedToolName?.(),
      agentLoopRunSeq: options.agentLoopRunSeq,
      llmSessionId: options.llmSessionId,
      llmCapabilities: options.llmCapabilities
    });
    input.setLastCompletedToolName?.(call.toolName);
    return result;
  }

  async function executeLLMToolCall(call: LLMToolCall, options: AgentLoopToolExecutionOptions = {}): Promise<AgentLoopExecutedToolCall> {
    const result = await executeToolCall({
      id: call.id,
      toolName: call.function.name,
      input: parseAgentLoopToolArguments(call.function.arguments)
    }, options);
    return {
      result,
      message: formatAgentLoopToolMessage(call.id, call.function.name, result, options.variables)
    };
  }

  return {
    toolMap,
    executePreparedToolCall,
    executeToolCall,
    executeLLMToolCall
  };
}

export async function executePreparedAgentLoopToolCall(
  toolMap: Map<string, ToolPlugin>,
  call: ToolCall,
  context: ToolExecutionContext = {}
): Promise<ToolResult> {
  const plugin = toolMap.get(call.toolName);
  if (!plugin) {
    return {
      callId: call.id,
      ok: false,
      error: `Unknown tool: ${call.toolName}`
    };
  }
  try {
    return await plugin.execute(call, context);
  } catch (error) {
    return {
      callId: call.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function buildAgentLoopToolMap(toolPlugins: ToolPlugin[]): Map<string, ToolPlugin> {
  const toolMap = new Map<string, ToolPlugin>();
  for (const plugin of toolPlugins) {
    for (const tool of plugin.listTools()) {
      toolMap.set(tool.name, plugin);
    }
  }
  return toolMap;
}

export async function runPromptToolRequest(
  _layer: unknown,
  call: AgentLoopPromptToolRequest,
  toolPlugins: ToolPlugin[]
): Promise<ToolResult> {
  return executePreparedAgentLoopToolCall(buildAgentLoopToolMap(toolPlugins), call);
}

export function parseAgentLoopToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function formatAgentLoopToolMessageContent(result: ToolResult, runtime: PromptContextRuntime | undefined): string {
  if (!runtime) throw new Error("prompt_context_runtime_required");
  if (!result.ok && typeof result.output === "string") return runtime.renderText(result.output);
  if (!result.ok) return result.error ? `error: ${runtime.renderText(result.error)}` : "error";
  if (typeof result.output === "string") return runtime.renderText(result.output);
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  return JSON.stringify(result.output);
}

export function formatAgentLoopToolMessage(
  callId: string,
  toolName: string,
  result: ToolResult,
  variables: PromptContextRuntime | undefined
): AgentLoopExecutedToolCall["message"] {
  return {
    role: "tool",
    toolCallId: callId,
    name: toolName,
    content: formatAgentLoopToolMessageContent(result, variables)
  };
}
