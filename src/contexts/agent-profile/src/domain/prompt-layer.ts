import type { LLMMessage } from "../../../../contexts/llm-gateway/src/index.js";
import { renderLLMText, type LLMTextVariables } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";

export type PromptLayerRole = "system" | "user" | "assistant" | "tool_request";

export type PromptLayerToolCall = {
  toolName: string;
  toolCallId?: string;
  toolArguments: string;
};

export type PromptLayer = {
  id: string;
  title: string;
  role: PromptLayerRole;
  enabled: boolean;
  content: string;
  order: number;
  toolCalls?: PromptLayerToolCall[];
  thinking?: string;
};

export type PromptLayerParserOptions = {
  defaultToolName?: string;
  toolCallIdPrefix?: string;
  allowedToolNames?: string[];
};

export function normalizePromptLayers(
  value: unknown,
  fallback: PromptLayer[] = []
): PromptLayer[] {
  const layers = Array.isArray(value) ? value : fallback;
  return layers.map((entry, index) => {
    const raw = entry && typeof entry === "object" ? entry as Partial<PromptLayer> : {};
    const role = normalizePromptLayerRole(raw.role);
    return {
      id: nonEmptyString(raw.id) ?? `layer_${index + 1}`,
      title: nonEmptyString(raw.title) ?? `Layer ${index + 1}`,
      role,
      enabled: raw.enabled !== false,
      content: typeof raw.content === "string" ? raw.content : "",
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : (index + 1) * 10,
      toolCalls: role === "tool_request" ? normalizePromptLayerToolCalls(raw.toolCalls) : undefined,
      thinking: (role === "assistant" || role === "tool_request") && typeof raw.thinking === "string" ? raw.thinking : undefined
    };
  });
}

export function promptLayerToMessage(
  layer: PromptLayer,
  variables: LLMTextVariables,
  options: PromptLayerParserOptions = {}
): LLMMessage {
  if (layer.role === "tool_request") {
    const prefix = options.toolCallIdPrefix ?? "prompt";
    return {
      role: "assistant",
      content: renderLLMText(layer.content || "", variables),
      reasoningContent: renderLLMText(layer.thinking ?? layer.content ?? "", variables),
      toolCalls: (layer.toolCalls ?? []).map((call, index) => ({
        id: call.toolCallId || `${prefix}_${layer.id}_${index + 1}`,
        type: "function",
        function: {
          name: normalizePromptToolName(call.toolName, options),
          arguments: renderLLMText(call.toolArguments, variables)
        }
      }))
    };
  }
  return {
    role: layer.role,
    content: renderLLMText(layer.content, variables),
    reasoningContent: layer.role === "assistant" && layer.thinking ? renderLLMText(layer.thinking, variables) : undefined
  };
}

export function parsePromptToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizePromptLayerRole(value: unknown): PromptLayerRole {
  if (value === "user" || value === "assistant" || value === "tool_request") return value;
  return "system";
}

function normalizePromptToolName(value: unknown, options: PromptLayerParserOptions): string {
  const fallback = options.defaultToolName ?? "";
  const name = nonEmptyString(value) ?? fallback;
  return options.allowedToolNames && !options.allowedToolNames.includes(name) ? fallback : name;
}

function normalizePromptLayerToolCalls(value: unknown): PromptLayerToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const raw = entry && typeof entry === "object" ? entry as Partial<PromptLayerToolCall> : {};
    return {
      toolName: nonEmptyString(raw.toolName) ?? "",
      toolCallId: nonEmptyString(raw.toolCallId),
      toolArguments: typeof raw.toolArguments === "string" ? raw.toolArguments : "{}"
    };
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
