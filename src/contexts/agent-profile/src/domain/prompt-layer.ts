import type { LLMMessage } from "../../../../core/llm/src/index.js";
import { renderLLMText, type LLMTextVariables } from "../../../../core/text-renderer/src/index.js";

export type PromptLayerRole = "system" | "user" | "assistant" | "tool_request";

export type PromptLayer = {
  id: string;
  title: string;
  role: PromptLayerRole;
  enabled: boolean;
  content: string;
  order: number;
  toolName?: string;
  toolCallId?: string;
  toolArguments?: string;
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
      toolName: role === "tool_request" ? nonEmptyString(raw.toolName) : undefined,
      toolCallId: role === "tool_request" ? nonEmptyString(raw.toolCallId) : undefined,
      toolArguments: role === "tool_request" && typeof raw.toolArguments === "string" ? raw.toolArguments : undefined,
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
    const toolName = normalizePromptToolName(layer.toolName, options);
    const prefix = options.toolCallIdPrefix ?? "prompt";
    const toolCallId = layer.toolCallId || `${prefix}_${layer.id}`;
    return {
      role: "assistant",
      content: renderLLMText(layer.content || "", variables),
      reasoningContent: renderLLMText(layer.thinking ?? layer.content ?? "", variables),
      toolCalls: [{
        id: toolCallId,
        type: "function",
        function: {
          name: toolName,
          arguments: renderLLMText(layer.toolArguments || "{}", variables)
        }
      }]
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
  const fallback = options.defaultToolName ?? "check_chat";
  const name = nonEmptyString(value) ?? fallback;
  return options.allowedToolNames && !options.allowedToolNames.includes(name) ? fallback : name;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
