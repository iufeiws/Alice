import type { LLMChatInput, LLMChatResult, LLMStreamHandlers, LLMToolSpec } from "./index.js";
import type { LLMRequestSender, LLMRequestSenderInput, LLMToolLoopRoundRequest } from "./llm-tool-loop.js";
import {
  createParenthesizedContentStripper,
  defaultLLMMessageSanitizationOptions,
  sanitizeLLMRequestMessages,
  sanitizeLLMResponseMessage,
  type LLMMessageSanitizationOptions
} from "./llm-message-sanitization.js";
import type { ToolDefinition } from "../../tool-execution/src/index.js";
import type { PromptContextRuntime } from "../../prompt-context/src/index.js";

export type LLMRequestLogEvent = {
  kind: "call_start" | "stream_start" | "stream_end" | "response_received";
  agentId: string;
  round: number;
  stream: boolean;
  model?: string;
  attempt?: number;
};

export type LLMRequestsDeps = {
  getTool(name: string): ToolDefinition | undefined;
  onRequestPrepared?(input: LLMRequestSenderInput, request: LLMChatInput): void;
  onResponseReceived?(input: LLMRequestSenderInput, request: LLMChatInput, result: LLMChatResult): void;
  onRequestSettled?(input: LLMRequestSenderInput): void;
  onLog?(event: LLMRequestLogEvent): void;
  messageSanitization?: LLMMessageSanitizationOptions;
};

export type LLMRequests = {
  send: LLMRequestSender;
  buildTools(toolNames: string[], runtime: PromptContextRuntime): LLMToolSpec[];
  cancelActive(reason?: string): boolean;
  isCancelRequested(): boolean;
  resetCancel(): void;
  /** 延迟递交的 response 最终化(格式化完成后)递交; 由调用方在 transform 后调用。 */
  flushResponseTranscript?(input: { round: number; result: LLMChatResult; request: LLMToolLoopRoundRequest }): void;
};

export function createLLMRequests(deps: LLMRequestsDeps): LLMRequests {
  let activeController: AbortController | undefined;
  let cancelRequested = false;

  function buildTools(toolNames: string[], runtime: PromptContextRuntime): LLMToolSpec[] {
    return buildToolsFromDefinitions(toolNames, runtime);
  }

  function buildToolsFromDefinitions(toolNames: string[], runtime: PromptContextRuntime | undefined, inlineTools: ToolDefinition[] = []): LLMToolSpec[] {
    if (toolNames.length > 0 && !runtime) throw new Error("prompt_context_runtime_required");
    const seen = new Set<string>();
    const inlineToolMap = new Map(inlineTools.map((tool) => [tool.name, tool]));
    const tools: LLMToolSpec[] = [];
    for (const name of toolNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      const tool = inlineToolMap.get(name) ?? deps.getTool(name);
      if (!tool) throw new Error(`unknown LLM tool: ${name}`);
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: runtime!.renderText(tool.description),
          parameters: renderToolInputSchema(tool.inputSchema, runtime!)
        }
      });
    }
    return tools;
  }

  async function send(input: LLMRequestSenderInput): Promise<LLMChatResult> {
    const client = input.client;
    if (!client) throw new Error("LLMRequests.send requires a client");
    cancelRequested = false;
    const requestController = new AbortController();
    activeController = requestController;
    const abort = () => requestController.abort();
    if (input.signal?.aborted) requestController.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const useStream = (input.stream === true || input.extraParams?.stream === true) && Boolean(client.chatStream);
    const request: LLMChatInput = {
      messages: sanitizeLLMRequestMessages(input.messages, deps.messageSanitization),
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      extraParams: withStreamUsageOptions(input.extraParams, useStream),
      presetName: input.presetName,
      callContext: { agentId: input.agentId },
      tools: buildToolsFromDefinitions(input.toolNames, input.toolVariables, input.inlineTools),
      signal: requestController.signal
    };
    try {
      try {
        deps.onRequestPrepared?.(input, request);
        if (cancelRequested || requestController.signal.aborted) throw new Error("llm_request_cancelled");
        deps.onLog?.({ kind: "call_start", agentId: input.agentId, round: input.round, stream: useStream, model: request.model, attempt: 1 });
        let result: LLMChatResult;
        if (useStream && client.chatStream) {
          deps.onLog?.({ kind: "stream_start", agentId: input.agentId, round: input.round, stream: true, model: request.model, attempt: 1 });
          try {
            result = sanitizeLLMChatResult(
              await client.chatStream(request, sanitizeStreamHandlers(input.streamHandlers, deps.messageSanitization)),
              deps.messageSanitization
            );
          } finally {
            deps.onLog?.({ kind: "stream_end", agentId: input.agentId, round: input.round, stream: true, model: request.model, attempt: 1 });
          }
        } else {
          result = sanitizeLLMChatResult(await client.chat(request), deps.messageSanitization);
          deps.onLog?.({ kind: "response_received", agentId: input.agentId, round: input.round, stream: false, model: request.model, attempt: 1 });
        }
        if (cancelRequested || requestController.signal.aborted) throw new Error("llm_request_cancelled");
        deps.onResponseReceived?.(input, request, result);
        return result;
      } catch (error) {
        if (cancelRequested || requestController.signal.aborted) throw new Error("llm_request_cancelled");
        throw error;
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (activeController === requestController) activeController = undefined;
      deps.onRequestSettled?.(input);
    }
  }

  function cancelActive(): boolean {
    cancelRequested = true;
    const hadActive = Boolean(activeController);
    activeController?.abort();
    return hadActive;
  }

  return {
    send,
    buildTools,
    cancelActive,
    isCancelRequested: () => cancelRequested,
    resetCancel: () => {
      cancelRequested = false;
    }
  };
}

function renderToolInputSchema(schema: Record<string, unknown>, runtime: PromptContextRuntime): Record<string, unknown> {
  return renderJsonSchemaNode(schema, runtime) as Record<string, unknown>;
}

function renderJsonSchemaNode(value: unknown, runtime: PromptContextRuntime): unknown {
  if (Array.isArray(value)) return value.map((entry) => renderJsonSchemaNode(entry, runtime));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if ((key === "description" || key === "title") && typeof entry === "string") return [key, runtime.renderText(entry)];
    return [key, renderJsonSchemaNode(entry, runtime)];
  }));
}

function sanitizeLLMChatResult(result: LLMChatResult, options?: LLMMessageSanitizationOptions): LLMChatResult {
  return {
    ...result,
    message: sanitizeLLMResponseMessage(result.message, options)
  };
}

function withStreamUsageOptions(extraParams: Record<string, unknown> | undefined, stream: boolean): Record<string, unknown> | undefined {
  if (!stream) return extraParams;
  const streamOptions = extraParams?.stream_options;
  return {
    ...(extraParams ?? {}),
    stream_options: {
      ...(streamOptions && typeof streamOptions === "object" && !Array.isArray(streamOptions) ? streamOptions : {}),
      include_usage: true
    }
  };
}

function sanitizeStreamHandlers(
  handlers: LLMStreamHandlers | undefined,
  options?: LLMMessageSanitizationOptions
): LLMStreamHandlers | undefined {
  if (!handlers) return undefined;
  const shouldSanitize = options?.removeParenthesizedAssistantResponseContent
    ?? defaultLLMMessageSanitizationOptions.removeParenthesizedAssistantResponseContent;
  if (!shouldSanitize || !handlers.onContentDelta) return handlers;
  const stripper = createParenthesizedContentStripper();
  return {
    ...handlers,
    async onContentDelta(content) {
      const sanitized = stripper.push(content);
      if (sanitized) await handlers.onContentDelta?.(sanitized);
    }
  };
}
