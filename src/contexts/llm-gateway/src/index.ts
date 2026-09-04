import {
  createParenthesizedContentStripper,
  defaultLLMMessageSanitizationOptions,
  sanitizeLLMRequestMessages,
  sanitizeLLMResponseMessage,
  type LLMMessageSanitizationOptions
} from "./llm-message-sanitization.js";
import { createOpenAIUpstreamRequester, normalizeOpenAIUsage } from "./llm-upstream-requester.js";
import { createApiKeyAuthorization, type RequestAuthorization } from "./request-authorization.js";

export type LLMRole = "system" | "user" | "assistant" | "tool";

export * from "./llm-log-runtime.js";
export * from "./llm-message-sanitization.js";
export * from "./llm-observability-runtime.js";
export * from "./llm-request-diff.js";
export * from "./llm-request-preview-runtime.js";
export * from "./llm-request-shape.js";
export * from "./llm-upstream-requester.js";
export * from "./llm-stream-loop-guard.js";
export * from "./token-usage-runtime.js";
export * from "./pi-preset-adapter.js";
export * from "./pi-llm-relay.js";
export * from "./request-authorization.js";
export * from "./credential-store.js";
export * from "./credential-runtime.js";
export * from "./xai-oauth-service.js";
export * from "./openai-responses-client.js";

export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export type LLMMessageContent = string | LLMContentPart[];

export type LLMMessage = {
  role: LLMRole;
  content: LLMMessageContent;
  reasoningContent?: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
};

export type LLMToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type LLMToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type LLMToolSpec = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type LLMChatInput = {
  protocol?: "openai-chat-completions" | "openai-responses";
  stream?: boolean;
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  tools?: LLMToolSpec[];
  maxTokens?: number;
  extraParams?: Record<string, unknown>;
  presetName?: string;
  callContext?: { agentId: string };
  signal?: AbortSignal;
};

export type LLMUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
};

export type LLMChatResult = {
  id?: string;
  model?: string;
  message: LLMMessage;
  finishReason?: string;
  usage?: LLMUsage;
  raw?: unknown;
};

export type LLMModel = {
  id: string;
  ownedBy?: string;
  raw?: unknown;
};

export interface LLMClient {
  chat(input: LLMChatInput): Promise<LLMChatResult>;
  chatStream?(input: LLMChatInput, handlers?: LLMStreamHandlers): Promise<LLMChatResult>;
  listModels?(): Promise<LLMModel[]>;
}

export type LLMStreamHandlers = {
  onContentDelta?(content: string): void | Promise<void>;
  onReasoningDelta?(content: string): void | Promise<void>;
  onToolCallDelta?(delta: LLMToolCallDelta): void | Promise<void>;
};

export type MutableLLMClient = LLMClient & {
  setClient(client: LLMClient): void;
  getClient(): LLMClient;
};

export type OpenAICompatibleConfig = {
  baseURL: string;
  apiKey?: string;
  authorization?: RequestAuthorization;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  useProxy?: boolean;
  extraParams?: Record<string, unknown>;
  messageSanitization?: LLMMessageSanitizationOptions;
};

type OpenAIChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: OpenAIUsage | null;
};

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  input_tokens_details?: {
    cached_tokens?: number;
    cache_read?: number;
  };
};

type OpenAIChatCompletionChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: OpenAIUsage | null;
};

type OpenAIToolCall = NonNullable<
  NonNullable<NonNullable<OpenAIChatCompletionResponse["choices"]>[number]["message"]>["tool_calls"]
>[number];

export function createOpenAICompatibleClient(config: OpenAICompatibleConfig): LLMClient {
  const baseURL = config.baseURL.replace(/\/+$/, "");
  const requestUpstream = createOpenAIUpstreamRequester({
    baseURL,
    authorization: config.authorization ?? (config.apiKey ? createApiKeyAuthorization(config.apiKey) : undefined),
    timeoutMs: config.timeoutMs,
    useProxy: config.useProxy
  });

  async function request<T>(path: string, init: RequestInit, signal?: AbortSignal, callContext?: { agentId: string }): Promise<T> {
    const { response, cleanup } = await requestUpstream({ path, init, signal, callContext });
    try {
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM request failed: ${response.status} ${response.statusText} ${body}`);
      }

      return (await response.json()) as T;
    } finally {
      cleanup();
    }
  }

  async function requestStream(
    path: string,
    body: Record<string, unknown>,
    handlers: LLMStreamHandlers | undefined,
    signal?: AbortSignal,
    callContext?: { agentId: string }
  ): Promise<LLMChatResult> {
    return requestUpstream({
      path,
      init: {
        method: "POST",
        body: JSON.stringify({ ...body, stream: true })
      },
      signal,
      callContext,
      async consume(response) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let completed = false;
        try {
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`LLM request failed: ${response.status} ${response.statusText} ${text}`);
          }
          if (!response.body) throw new Error("LLM stream response did not include a body");

          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let id: string | undefined;
          let model: string | undefined;
          let content = "";
          let reasoningContent = "";
          let finishReason: string | undefined;
          let rawUsage: OpenAIUsage | null | undefined;
          let usage: LLMUsage | undefined;
          const toolCalls = new Map<number, LLMToolCall>();
          const contentStripper = shouldSanitizeAssistantResponseContent()
            ? createParenthesizedContentStripper()
            : undefined;
          const processLine = async (line: string) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) return;
            const data = trimmed.slice("data:".length).trim();
            if (!data || data === "[DONE]") return;
            const chunk = JSON.parse(data) as OpenAIChatCompletionChunk;
            id = chunk.id ?? id;
            model = chunk.model ?? model;
            rawUsage = chunk.usage ?? rawUsage;
            usage = normalizeOpenAIUsage(chunk.usage) ?? usage;
            const choice = chunk.choices?.[0];
            finishReason = choice?.finish_reason ?? finishReason;
            const deltaContent = choice?.delta?.content;
            if (deltaContent) {
              const sanitizedDelta = contentStripper ? contentStripper.push(deltaContent) : deltaContent;
              content += sanitizedDelta;
              if (sanitizedDelta) await handlers?.onContentDelta?.(sanitizedDelta);
            }
            const deltaReasoningContent = choice?.delta?.reasoning_content;
            if (deltaReasoningContent) {
              reasoningContent += deltaReasoningContent;
              await handlers?.onReasoningDelta?.(deltaReasoningContent);
            }
            for (const rawCall of choice?.delta?.tool_calls ?? []) {
              const index = typeof rawCall.index === "number" ? rawCall.index : 0;
              const current = toolCalls.get(index) ?? {
                id: rawCall.id ?? `tool_${index}`,
                type: "function" as const,
                function: {
                  name: "",
                  arguments: ""
                }
              };
              if (rawCall.id) current.id = rawCall.id;
              if (rawCall.function?.name) current.function.name = rawCall.function.name;
              if (rawCall.function?.arguments) current.function.arguments += rawCall.function.arguments;
              toolCalls.set(index, current);
              await handlers?.onToolCallDelta?.({
                index,
                id: rawCall.id,
                type: rawCall.type === "function" ? "function" : undefined,
                function: {
                  name: rawCall.function?.name,
                  arguments: rawCall.function?.arguments
                }
              });
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              await processLine(line);
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) await processLine(buffer);
          completed = true;

          return {
            id,
            model,
            message: sanitizeOpenAIResponseMessage({
              role: "assistant",
              content,
              reasoningContent: reasoningContent || undefined,
              toolCalls: [...toolCalls.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, call]) => call)
                .filter((call) => call.function.name)
            }),
            finishReason,
            usage,
            raw: rawUsage === undefined ? undefined : { usage: rawUsage }
          };
        } finally {
          if (!completed) await reader?.cancel().catch(() => undefined);
        }
      }
    });
  }

  return {
    async chat(input) {
      const body: Record<string, unknown> = {
        ...(input.extraParams ?? config.extraParams ?? {}),
        model: input.model ?? config.model,
        messages: sanitizeOpenAIMessages(input.messages),
        temperature: input.temperature ?? config.temperature ?? 0.2
      };
      if (input.tools !== undefined) body.tools = input.tools;
      if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;

      const json = await request<OpenAIChatCompletionResponse>("/chat/completions", {
        method: "POST",
        body: JSON.stringify(body)
      }, input.signal, input.callContext);

      const choice = json.choices?.[0];
      return {
        id: json.id,
        model: json.model,
        message: sanitizeOpenAIResponseMessage({
          role: "assistant",
          content: choice?.message?.content ?? "",
          reasoningContent: choice?.message?.reasoning_content ?? undefined,
          toolCalls: normalizeToolCalls(choice?.message?.tool_calls)
        }),
        finishReason: choice?.finish_reason,
        usage: normalizeOpenAIUsage(json.usage),
        raw: json
      };
    },
    async chatStream(input, handlers) {
      const body: Record<string, unknown> = {
        ...(input.extraParams ?? config.extraParams ?? {}),
        model: input.model ?? config.model,
        messages: sanitizeOpenAIMessages(input.messages),
        temperature: input.temperature ?? config.temperature ?? 0.2
      };
      if (input.tools !== undefined) body.tools = input.tools;
      if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
      return requestStream("/chat/completions", body, handlers, input.signal, input.callContext);
    },
    async listModels() {
      const json = await request<{ data?: Array<{ id: string; owned_by?: string }> }>("/models", {
        method: "GET"
      });

      return (json.data ?? []).map((model) => ({
        id: model.id,
        ownedBy: model.owned_by,
        raw: model
      }));
    }
  };

  function sanitizeOpenAIMessages(messages: LLMMessage[]): Record<string, unknown>[] {
    return sanitizeLLMRequestMessages(messages, config.messageSanitization).map(toOpenAIMessage);
  }

  function sanitizeOpenAIResponseMessage(message: LLMMessage): LLMMessage {
    return sanitizeLLMResponseMessage(message, config.messageSanitization);
  }

  function shouldSanitizeAssistantResponseContent(): boolean {
    return config.messageSanitization?.removeParenthesizedAssistantResponseContent
      ?? defaultLLMMessageSanitizationOptions.removeParenthesizedAssistantResponseContent;
  }
}

function toOpenAIMessage(message: LLMMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content
  };
  if (message.name) result.name = message.name;
  if (message.toolCallId) result.tool_call_id = message.toolCallId;
  if (message.reasoningContent !== undefined || (message.toolCalls?.length ?? 0) > 0) {
    result.reasoning_content = message.reasoningContent ?? "";
  }
  if (message.toolCalls) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: call.type,
      function: {
        name: call.function.name,
        arguments: call.function.arguments
      }
    }));
  }
  return result;
}

function normalizeToolCalls(raw: OpenAIToolCall[] | undefined): LLMToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls = raw
    .map((call) => {
      const id = typeof call.id === "string" ? call.id : "";
      const name = typeof call.function?.name === "string" ? call.function.name : "";
      if (!id || !name) return undefined;
      return {
        id,
        type: "function" as const,
        function: {
          name,
          arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}"
        }
      };
    })
    .filter((call): call is LLMToolCall => Boolean(call));
  return calls.length > 0 ? calls : undefined;
}

export function createMutableLLMClient(initialClient: LLMClient): MutableLLMClient {
  let currentClient = initialClient;
  return {
    setClient(client) {
      currentClient = client;
    },
    getClient() {
      return currentClient;
    },
    chat(input) {
      return currentClient.chat(input);
    },
    chatStream(input, handlers) {
      return currentClient.chatStream ? currentClient.chatStream(input, handlers) : currentClient.chat(input);
    },
    listModels() {
      return currentClient.listModels ? currentClient.listModels() : Promise.resolve([]);
    }
  };
}

export function createStubLLMClient(): LLMClient {
  return {
    async chat(input) {
      const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");

      return {
        model: "stub",
        message: {
          role: "assistant",
          content: lastUserMessage?.content
            ? `Stub LLM response: ${stringifyMessageContent(lastUserMessage.content)}`
            : "Stub LLM response."
        },
        finishReason: "stop"
      };
    },
    async listModels() {
      return [{ id: "stub" }];
    }
  };
}

function stringifyMessageContent(content: LLMMessageContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
}
