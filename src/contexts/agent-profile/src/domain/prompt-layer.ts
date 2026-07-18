import type { LLMContentPart, LLMMessage, LLMRole, LLMToolCall } from "../../../../contexts/llm-gateway/src/index.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";

export type PromptMessageMeta = {
  title: string;
  enabled: boolean;
};

export type PromptMessage = LLMMessage & {
  meta: PromptMessageMeta;
};

export type PromptLayer<TMeta extends Record<string, unknown> = Record<string, unknown>> = {
  meta: TMeta;
  messages: PromptMessage[];
};

export function normalizePromptLayer(
  value: unknown,
  fallback: PromptLayer = { meta: {}, messages: [] }
): PromptLayer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return cloneLayer(fallback);
  const raw = value as { meta?: unknown; messages?: unknown };
  if (!raw.meta || typeof raw.meta !== "object" || Array.isArray(raw.meta) || !Array.isArray(raw.messages)) {
    return cloneLayer(fallback);
  }
  return {
    meta: { ...raw.meta as Record<string, unknown> },
    messages: raw.messages.map(normalizePromptMessage)
  };
}

export function promptMessageToMessage(message: PromptMessage, renderer: PromptContextRuntime): LLMMessage {
  return {
    role: message.role,
    content: renderContent(message.content, renderer),
    ...(message.name ? { name: renderer.renderText(message.name) } : {}),
    ...(message.reasoningContent !== undefined ? { reasoningContent: renderer.renderText(message.reasoningContent) } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? {
      toolCalls: message.toolCalls.map((call) => ({
        ...call,
        function: {
          name: call.function.name,
          arguments: renderer.renderText(call.function.arguments)
        }
      }))
    } : {})
  };
}

export function parsePromptToolArguments(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("prompt_tool_arguments_object_required");
  return parsed as Record<string, unknown>;
}

function normalizePromptMessage(value: unknown, index: number): PromptMessage {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<PromptMessage>
    : {};
  const meta = raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
    ? raw.meta as Partial<PromptMessageMeta>
    : {};
  return {
    meta: {
      title: typeof meta.title === "string" ? meta.title : `Message ${index + 1}`,
      enabled: meta.enabled !== false
    },
    role: normalizeRole(raw.role),
    content: normalizeContent(raw.content),
    ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
    ...(typeof raw.reasoningContent === "string" ? { reasoningContent: raw.reasoningContent } : {}),
    ...(typeof raw.toolCallId === "string" && raw.toolCallId ? { toolCallId: raw.toolCallId } : {}),
    ...(Array.isArray(raw.toolCalls) ? { toolCalls: raw.toolCalls.map(normalizeToolCall) } : {})
  };
}

function normalizeRole(value: unknown): LLMRole {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") return value;
  return "system";
}

function normalizeContent(value: unknown): LLMMessage["content"] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part): LLMContentPart[] => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const raw = part as Record<string, unknown>;
    if (raw.type === "text" && typeof raw.text === "string") return [{ type: "text", text: raw.text }];
    if (raw.type === "image_url" && raw.image_url && typeof raw.image_url === "object") {
      const url = (raw.image_url as { url?: unknown }).url;
      return typeof url === "string" ? [{ type: "image_url", image_url: { url } }] : [];
    }
    if (raw.type === "input_audio" && raw.input_audio && typeof raw.input_audio === "object") {
      const audio = raw.input_audio as { data?: unknown; format?: unknown };
      return typeof audio.data === "string" && typeof audio.format === "string"
        ? [{ type: "input_audio", input_audio: { data: audio.data, format: audio.format } }]
        : [];
    }
    return [];
  });
}

function normalizeToolCall(value: unknown): LLMToolCall {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<LLMToolCall>
    : {};
  const fn = raw.function && typeof raw.function === "object" ? raw.function : { name: "", arguments: "{}" };
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type: "function",
    function: {
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : "{}"
    }
  };
}

function renderContent(content: LLMMessage["content"], renderer: PromptContextRuntime): LLMMessage["content"] {
  if (typeof content === "string") return renderer.renderText(content);
  return content.map((part) => {
    if (part.type === "text") return { ...part, text: renderer.renderText(part.text) };
    if (part.type === "image_url") return { ...part, image_url: { url: renderer.renderText(part.image_url.url) } };
    return part;
  });
}

function cloneLayer(layer: PromptLayer): PromptLayer {
  return JSON.parse(JSON.stringify(layer)) as PromptLayer;
}
