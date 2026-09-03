import type { LLMChatInput, LLMChatResult, LLMClient, LLMContentPart, LLMMessage, LLMStreamHandlers, LLMToolCall } from "./index.js";
import { createOpenAIUpstreamRequester, normalizeOpenAIUsage } from "./llm-upstream-requester.js";
import type { RequestAuthorization } from "./request-authorization.js";

export type OpenAIResponsesConfig = {
  baseURL: string;
  authorization: RequestAuthorization;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  useProxy?: boolean;
  extraParams?: Record<string, unknown>;
};

export function createOpenAIResponsesClient(config: OpenAIResponsesConfig): LLMClient {
  const requestUpstream = createOpenAIUpstreamRequester({
    baseURL: config.baseURL,
    authorization: config.authorization,
    timeoutMs: config.timeoutMs,
    useProxy: config.useProxy
  });

  return {
    async chat(input) {
      const body = buildOpenAIResponsesRequest(input, config);
      const { response, cleanup } = await requestUpstream({
        path: "/responses",
        init: { method: "POST", body: JSON.stringify(body) },
        signal: input.signal,
        callContext: input.callContext
      });
      try {
        if (!response.ok) throw await responseError(response);
        return normalizeResponse(await response.json() as Record<string, unknown>);
      } finally {
        cleanup();
      }
    },
    async chatStream(input, handlers) {
      const body = { ...buildOpenAIResponsesRequest(input, config), stream: true };
      return requestUpstream({
        path: "/responses",
        init: { method: "POST", body: JSON.stringify(body) },
        signal: input.signal,
        callContext: input.callContext,
        consume: (response) => consumeResponsesStream(response, handlers)
      });
    }
  };
}

export function buildOpenAIResponsesRequest(
  input: LLMChatInput,
  defaults: Pick<OpenAIResponsesConfig, "model" | "temperature" | "extraParams">
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(input.extraParams ?? defaults.extraParams ?? {}),
    model: input.model ?? defaults.model,
    input: toResponsesInput(input.messages)
  };
  const temperature = input.temperature ?? defaults.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  if (input.maxTokens !== undefined) body.max_output_tokens = input.maxTokens;
  if (input.tools !== undefined) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters ?? {}
    }));
  }
  delete body.messages;
  delete body.max_tokens;
  delete body.stream_options;
  delete body.stream;
  return body;
}

function toResponsesInput(messages: LLMMessage[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("responses_tool_call_id_missing");
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: contentText(message.content) });
      continue;
    }
    input.push({ type: "message", role: message.role, content: responsesContent(message) });
    for (const call of message.toolCalls ?? []) {
      input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return input;
}

function responsesContent(message: LLMMessage): Array<Record<string, unknown>> {
  if (typeof message.content === "string") {
    return message.content ? [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }] : [];
  }
  return message.content.map((part) => responseContentPart(part, message.role));
}

function responseContentPart(part: LLMContentPart, role: LLMMessage["role"]): Record<string, unknown> {
  if (part.type === "text") return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
  if (part.type === "image_url") {
    if (role === "assistant") throw new Error("responses_assistant_image_unsupported");
    return { type: "input_image", image_url: part.image_url.url };
  }
  throw new Error("responses_audio_input_unsupported");
}

function contentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type !== "text") throw new Error("responses_tool_output_must_be_text");
    return part.text;
  }).join("\n");
}

function normalizeResponse(raw: Record<string, unknown>): LLMChatResult {
  const output = Array.isArray(raw.output) ? raw.output as Array<Record<string, unknown>> : [];
  let content = "";
  let reasoningContent = "";
  const toolCalls: LLMToolCall[] = [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content as Array<Record<string, unknown>>) {
        if (part.type === "output_text" && typeof part.text === "string") content += part.text;
      }
    } else if (item.type === "reasoning") {
      reasoningContent += reasoningText(item);
    } else if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" }
      });
    }
  }
  return {
    id: stringValue(raw.id),
    model: stringValue(raw.model),
    message: { role: "assistant", content, reasoningContent: reasoningContent || undefined, toolCalls: toolCalls.length ? toolCalls : undefined },
    finishReason: responseFinishReason(raw, toolCalls.length > 0),
    usage: normalizeOpenAIUsage(raw.usage),
    raw
  };
}

async function consumeResponsesStream(response: Response, handlers?: LLMStreamHandlers): Promise<LLMChatResult> {
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error("LLM stream response did not include a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let completed: Record<string, unknown> | undefined;
  const calls = new Map<number, LLMToolCall>();
  const processLine = async (line: string) => {
    if (!line.startsWith("data:")) return;
    const text = line.slice(5).trim();
    if (!text || text === "[DONE]") return;
    const event = JSON.parse(text) as Record<string, unknown>;
    const type = stringValue(event.type);
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      content += event.delta;
      await handlers?.onContentDelta?.(event.delta);
    } else if ((type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") && typeof event.delta === "string") {
      reasoningContent += event.delta;
      await handlers?.onReasoningDelta?.(event.delta);
    } else if (type === "response.output_item.added") {
      const item = objectValue(event.item);
      if (item?.type === "function_call") {
        const index = numberValue(event.output_index) ?? calls.size;
        const call: LLMToolCall = {
          id: stringValue(item.call_id) ?? `tool_${index}`,
          type: "function",
          function: { name: stringValue(item.name) ?? "", arguments: stringValue(item.arguments) ?? "" }
        };
        calls.set(index, call);
        await handlers?.onToolCallDelta?.({ index, id: call.id, type: "function", function: { name: call.function.name || undefined } });
      }
    } else if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const index = numberValue(event.output_index) ?? 0;
      const call = calls.get(index) ?? { id: stringValue(event.item_id) ?? `tool_${index}`, type: "function" as const, function: { name: "", arguments: "" } };
      call.function.arguments += event.delta;
      calls.set(index, call);
      await handlers?.onToolCallDelta?.({ index, function: { arguments: event.delta } });
    } else if (type === "response.output_item.done") {
      const item = objectValue(event.item);
      if (item?.type === "function_call") {
        const index = numberValue(event.output_index) ?? 0;
        const call = calls.get(index);
        if (call) {
          call.id = stringValue(item.call_id) ?? call.id;
          call.function.name = stringValue(item.name) ?? call.function.name;
          call.function.arguments = stringValue(item.arguments) ?? call.function.arguments;
        }
      }
    } else if (type === "response.completed") {
      completed = objectValue(event.response);
    } else if (type === "response.failed") {
      throw new Error(`LLM responses stream failed: ${JSON.stringify(event.response ?? event)}`);
    }
  };
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) await processLine(line.trim());
  }
  buffer += decoder.decode();
  if (buffer.trim()) await processLine(buffer.trim());
  const normalized = completed ? normalizeResponse(completed) : undefined;
  return {
    id: normalized?.id,
    model: normalized?.model,
    message: {
      role: "assistant",
      content: content || String(normalized?.message.content ?? ""),
      reasoningContent: reasoningContent || normalized?.message.reasoningContent,
      toolCalls: calls.size ? [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) : normalized?.message.toolCalls
    },
    finishReason: calls.size ? "tool_calls" : normalized?.finishReason ?? "stop",
    usage: normalized?.usage,
    raw: completed
  };
}

function reasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary as Array<Record<string, unknown>> : [];
  return summary.map((part) => stringValue(part.text) ?? "").join("");
}

function responseFinishReason(raw: Record<string, unknown>, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  const status = stringValue(raw.status);
  if (status === "completed") return "stop";
  const incomplete = objectValue(raw.incomplete_details);
  return stringValue(incomplete?.reason) ?? status ?? "stop";
}

async function responseError(response: Response): Promise<Error> {
  return new Error(`LLM request failed: ${response.status} ${response.statusText} ${await response.text()}`);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
