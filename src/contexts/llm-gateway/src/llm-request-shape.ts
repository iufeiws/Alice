import type { LLMChatInput } from "./index.js";
import { sanitizeLLMRequestMessages } from "./llm-message-sanitization.js";
import type { StoredConversationMessage } from "../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { buildOpenAIResponsesRequest } from "./openai-responses-client.js";

export function buildRawLLMRequest(input: Pick<LLMChatInput, "protocol" | "stream" | "model" | "temperature" | "messages" | "tools" | "maxTokens" | "extraParams">): unknown {
  if (input.protocol === "openai-responses") {
    const result = buildOpenAIResponsesRequest(input, { model: input.model ?? "", temperature: input.temperature, extraParams: input.extraParams });
    if (input.stream !== false) result.stream = true;
    return result;
  }
  const result: Record<string, unknown> = {
    ...(input.extraParams ?? {}),
    model: input.model,
    stream: input.stream !== false,
    temperature: input.temperature,
    messages: sanitizeLLMRequestMessages(input.messages).map((message) => {
      const entry: Record<string, unknown> = {
        role: message.role,
        content: message.content
      };
      if (message.name) entry.name = message.name;
      if (message.toolCallId) entry.tool_call_id = message.toolCallId;
      if (message.reasoningContent) entry.reasoning_content = message.reasoningContent;
      if (message.toolCalls) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: call.type,
          function: {
            name: call.function.name,
            arguments: call.function.arguments
          }
        }));
      }
      return entry;
    })
  };
  if (input.stream !== false) {
    const configured = result.stream_options;
    result.stream_options = {
      ...(configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {}),
      include_usage: true
    };
  }
  if (input.tools !== undefined) result.tools = input.tools;
  if (input.maxTokens !== undefined) result.max_tokens = input.maxTokens;
  return result;
}

export function formatPreviewContextLine(entry: StoredConversationMessage): string {
  const speaker = entry.direction === "outbound" ? "Assistant" : "User";
  const recalled = entry.isRecalled ? " [recalled]" : "";
  const read = entry.isRead ? " [read]" : "";
  const reactions = summarizePreviewReactions(entry.reactionsJson);
  return `${speaker}${recalled}${read}${reactions ? ` [reactions: ${reactions}]` : ""}: ${entry.isRecalled ? "(message recalled)" : entry.contentText}`;
}

function summarizePreviewReactions(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, { count?: unknown }>;
    return Object.entries(parsed)
      .map(([emoji, value]) => `${emoji}:${typeof value.count === "number" ? value.count : 0}`)
      .filter((part) => !part.endsWith(":0"))
      .join(", ");
  } catch {
    return "";
  }
}
