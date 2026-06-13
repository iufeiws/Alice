import { renderLLMValue, type LLMTextVariables } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import type { LLMChatInput, LLMChatResult, LLMClient } from "../../../llm-gateway/src/index.js";
import type { LLMRequestSender } from "../../../llm-gateway/src/llm-tool-loop.js";
import type { LLMRequestLogEntry } from "../../../llm-session/src/index.js";
import type { ToolPlugin } from "../contracts/agent-contracts.js";

const maxLLMRetryAttempts = 3;

export type ChatLoopRequestSenderLog = {
  kind: "call_start" | "stream_start" | "stream_end" | "response_received" | "rate_limited" | "retry" | "wait_chat_resume_error";
  round: number;
  stream: boolean;
  model?: string;
  attempt?: number;
  error?: string;
  delayMs?: number;
};

export type ChatLoopRequestSenderInput = {
  llm: LLMClient;
  toolPlugins: ToolPlugin[];
  onLLMRequestPrepared?(input: LLMChatInput): LLMRequestLogEntry | undefined | void;
  onLLMResponseReceived?(result: LLMChatResult, request?: LLMRequestLogEntry): void;
  onLLMLog?(event: ChatLoopRequestSenderLog): void;
};

export function createChatLoopRequestSender(input: ChatLoopRequestSenderInput): LLMRequestSender {
  return async (request) => {
    const client = request.client ?? input.llm;
    const requestInput: LLMChatInput = {
      messages: request.messages,
      model: request.model,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      extraParams: request.extraParams,
      presetName: request.presetName,
      tools: buildLocalToolSpecs(input.toolPlugins, request.toolNames, request.toolVariables as LLMTextVariables | undefined)
    };
    const requestLog = input.onLLMRequestPrepared?.(requestInput);
    const useStream = request.stream === true && Boolean(client.chatStream);
    let lastError: unknown;
    let result: LLMChatResult | undefined;
    for (let attempt = 1; attempt <= maxLLMRetryAttempts; attempt += 1) {
      input.onLLMLog?.({ kind: "call_start", round: request.round, stream: useStream, model: requestInput.model, attempt });
      try {
        if (useStream && client.chatStream) {
          input.onLLMLog?.({ kind: "stream_start", round: request.round, stream: true, model: requestInput.model, attempt });
          try {
            result = await client.chatStream(requestInput, request.streamHandlers);
          } finally {
            input.onLLMLog?.({ kind: "stream_end", round: request.round, stream: true, model: requestInput.model, attempt });
          }
        } else {
          result = await client.chat(requestInput);
          input.onLLMLog?.({ kind: "response_received", round: request.round, stream: false, model: requestInput.model, attempt });
        }
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= maxLLMRetryAttempts || !isRetryableLLMError(error)) throw error;
        const delayMs = llmRetryDelayMs(attempt);
        input.onLLMLog?.({
          kind: "retry",
          round: request.round,
          stream: useStream,
          model: requestInput.model,
          attempt,
          error: error instanceof Error ? error.message : String(error),
          delayMs
        });
        await sleep(delayMs);
      }
    }
    if (!result) throw lastError;
    input.onLLMResponseReceived?.(result, requestLog || undefined);
    return result;
  };
}

function buildLocalToolSpecs(toolPlugins: ToolPlugin[], toolNames: string[], variables?: LLMTextVariables): LLMChatInput["tools"] {
  const seen = new Set<string>();
  const specs: LLMChatInput["tools"] = [];
  for (const name of toolNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const plugin = findToolPlugin(toolPlugins, name);
    const tool = plugin?.listTools().find((entry) => entry.name === name);
    if (!tool) throw new Error(`unknown LLM tool: ${name}`);
    specs.push({
      type: "function",
      function: {
        name: tool.name,
        description: renderLLMTextValue(tool.description, variables ?? {}),
        parameters: renderLLMValue(tool.inputSchema, variables ?? {}) as Record<string, unknown>
      }
    });
  }
  return specs;
}

function findToolPlugin(tools: ToolPlugin[], toolName: string): ToolPlugin | undefined {
  return tools.find((plugin) => plugin.listTools().some((tool) => tool.name === toolName));
}

function renderLLMTextValue(value: string, variables: LLMTextVariables): string {
  return String(renderLLMValue(value, variables));
}

function isRetryableLLMError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b/.test(message)
    || /service[_ ]unavailable|too busy|temporarily|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
}

function llmRetryDelayMs(attempt: number): number {
  void attempt;
  return 1_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
