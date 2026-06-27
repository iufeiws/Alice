import type { LLMChatInput, LLMChatResult, LLMClient, LLMStreamHandlers, LLMToolSpec } from "./index.js";
import type { LLMRequestSender, LLMRequestSenderInput } from "./llm-tool-loop.js";
import {
  createParenthesizedContentStripper,
  defaultLLMMessageSanitizationOptions,
  sanitizeLLMRequestMessages,
  sanitizeLLMResponseMessage,
  type LLMMessageSanitizationOptions
} from "./llm-message-sanitization.js";
import { renderLLMValue, type LLMTextVariables } from "../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import type { ToolDefinition } from "../../agent-loop/src/contracts/agent-contracts.js";

export type LLMRequestLogEvent = {
  kind: "call_start" | "stream_start" | "stream_end" | "response_received" | "retry";
  agentId: string;
  round: number;
  stream: boolean;
  model?: string;
  attempt?: number;
  error?: string;
  delayMs?: number;
};

export type LLMRequestsDeps = {
  getTool(name: string): ToolDefinition | undefined;
  onRequestPrepared?(input: LLMRequestSenderInput, request: LLMChatInput): void;
  onResponseReceived?(input: LLMRequestSenderInput, request: LLMChatInput, result: LLMChatResult): void;
  onRequestSettled?(input: LLMRequestSenderInput): void;
  onLog?(event: LLMRequestLogEvent): void;
  messageSanitization?: LLMMessageSanitizationOptions;
  retryDelayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
};

export type LLMRequests = {
  send: LLMRequestSender;
  buildTools(toolNames: string[], variables?: Record<string, unknown>): LLMToolSpec[];
  cancelActive(reason?: string): boolean;
  isCancelRequested(): boolean;
  resetCancel(): void;
};

const maxLLMRetryAttempts = 3;

export function createLLMRequests(deps: LLMRequestsDeps): LLMRequests {
  const retryDelayMs = deps.retryDelayMs ?? (() => 1_000);
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let activeController: AbortController | undefined;
  let cancelRequested = false;

  function buildTools(toolNames: string[], variables?: Record<string, unknown>): LLMToolSpec[] {
    return buildToolsFromDefinitions(toolNames, variables);
  }

  function buildToolsFromDefinitions(toolNames: string[], variables?: Record<string, unknown>, inlineTools: ToolDefinition[] = []): LLMToolSpec[] {
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
          description: String(renderLLMValue(tool.description, variables as LLMTextVariables | undefined)),
          parameters: renderLLMValue(tool.inputSchema, variables as LLMTextVariables | undefined) as Record<string, unknown>
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
    const renderedExtraParams = renderLLMValue(input.extraParams, input.toolVariables as LLMTextVariables | undefined);
    const useStream = (input.stream === true || renderedExtraParams?.stream === true) && Boolean(client.chatStream);
    const request: LLMChatInput = {
      messages: sanitizeLLMRequestMessages(input.messages, deps.messageSanitization),
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      extraParams: withStreamUsageOptions(renderedExtraParams, useStream),
      presetName: input.presetName,
      tools: buildToolsFromDefinitions(input.toolNames, input.toolVariables, input.inlineTools),
      signal: requestController.signal
    };
    try {
      deps.onRequestPrepared?.(input, request);
      let lastError: unknown;
      let result: LLMChatResult | undefined;
      for (let attempt = 1; attempt <= maxLLMRetryAttempts; attempt += 1) {
        if (cancelRequested || requestController.signal.aborted) throw new Error("llm_request_cancelled");
        deps.onLog?.({ kind: "call_start", agentId: input.agentId, round: input.round, stream: useStream, model: request.model, attempt });
        try {
          if (useStream && client.chatStream) {
            deps.onLog?.({ kind: "stream_start", agentId: input.agentId, round: input.round, stream: true, model: request.model, attempt });
            try {
              result = sanitizeLLMChatResult(
                await client.chatStream(request, sanitizeStreamHandlers(input.streamHandlers, deps.messageSanitization)),
                deps.messageSanitization
              );
            } finally {
              deps.onLog?.({ kind: "stream_end", agentId: input.agentId, round: input.round, stream: true, model: request.model, attempt });
            }
          } else {
            result = sanitizeLLMChatResult(await client.chat(request), deps.messageSanitization);
            deps.onLog?.({ kind: "response_received", agentId: input.agentId, round: input.round, stream: false, model: request.model, attempt });
          }
          break;
        } catch (error) {
          lastError = error;
          if (cancelRequested || requestController.signal.aborted) throw new Error("llm_request_cancelled");
          if (attempt >= maxLLMRetryAttempts || !isRetryableLLMError(error)) throw error;
          const delayMs = retryDelayMs(attempt);
          deps.onLog?.({
            kind: "retry",
            agentId: input.agentId,
            round: input.round,
            stream: useStream,
            model: request.model,
            attempt,
            error: error instanceof Error ? error.message : String(error),
            delayMs
          });
          await sleep(delayMs);
        }
      }
      if (!result) throw lastError;
      if (cancelRequested || requestController.signal.aborted) throw new Error("llm_request_cancelled");
      deps.onResponseReceived?.(input, request, result);
      return result;
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

function isRetryableLLMError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b/.test(message)
    || /service[_ ]unavailable|too busy|temporarily|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
}
