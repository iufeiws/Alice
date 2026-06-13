import { createLLMRequests } from "./llm-requests.js";
import type { LLMRequestLogEntry } from "../../../contexts/llm-session/src/index.js";

export function createLLMRequestsRuntime(input: {
  getTool(name: string): any;
  appendLLMRequestLog(request: any, agentId?: "chat" | "talk"): LLMRequestLogEntry | undefined;
  appendLLMResponseLog(result: any, agentId?: "chat" | "talk", request?: LLMRequestLogEntry): void;
  appendLLMUsageLog(result: any, model?: string): void;
  recordTokenUsageEvent(event: any): void;
  time: any;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const requestLogEntries = new WeakMap<object, LLMRequestLogEntry>();
  return createLLMRequests({
    getTool: input.getTool,
    onRequestPrepared(requestInput, request) {
      if (requestInput.agentId === "chat" || requestInput.agentId === "talk") {
        const entry = input.appendLLMRequestLog(request, requestInput.agentId);
        if (entry) requestLogEntries.set(requestInput, entry);
      }
    },
    onResponseReceived(requestInput, request, result) {
      if (requestInput.agentId === "chat" || requestInput.agentId === "talk") {
        input.appendLLMResponseLog(result, requestInput.agentId, requestLogEntries.get(requestInput));
        return;
      }
      input.appendLLMUsageLog(result, result.model ?? request.model);
      const createdTime = input.time.now();
      input.recordTokenUsageEvent({
        createdAt: createdTime.iso,
        createdAtUtc: createdTime.date.toISOString(),
        agentId: requestInput.agentId,
        model: result.model ?? request.model,
        result
      });
    },
    onLog(event) {
      const mode = event.stream ? "stream" : "non-stream";
      const fallbackModel = event.agentId === "memorize"
        ? input.resolvePromptApiPreset("memorize")?.model
        : input.resolvePromptApiPreset("chat")?.model;
      if (event.kind === "call_start") {
        input.appendLog("info", `llm call start: agent=${event.agentId} round=${event.round} mode=${mode} model=${event.model ?? fallbackModel}`);
      }
      if (event.kind === "stream_start") input.appendLog("info", `llm stream start: agent=${event.agentId} round=${event.round} model=${event.model ?? fallbackModel}`);
      if (event.kind === "stream_end") input.appendLog("info", `llm stream end: agent=${event.agentId} round=${event.round} model=${event.model ?? fallbackModel}`);
      if (event.kind === "response_received") input.appendLog("info", `llm response received: agent=${event.agentId} round=${event.round} mode=${mode} model=${event.model ?? fallbackModel}`);
      if (event.kind === "retry") input.appendLog("warn", `llm retry: agent=${event.agentId} round=${event.round} attempt=${event.attempt ?? "?"} delay=${event.delayMs ?? "?"}ms error=${event.error ?? ""}`);
    }
  });
}
