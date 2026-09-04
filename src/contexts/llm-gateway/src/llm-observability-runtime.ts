import { createTokenUsageRuntime } from "./token-usage-runtime.js";
import { createLLMLogRuntime } from "./llm-log-runtime.js";
import { createModelPriceSync } from "./model-price-sync.js";
import {
  setOpenAICallObserver,
  setOpenAIStreamLoopObserver,
  type OpenAICallEvent,
  type OpenAIStreamLoopEvent
} from "./llm-upstream-requester.js";

const UNKNOWN_PROVIDER_ID = "unknown";

export function createLLMObservabilityRuntime(input: {
  time: any;
  tokenUsageStore: any;
  requestLogs: any[];
  responseLogs: any[];
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  agentLoopRuntime: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  modelCatalogFetch?: typeof fetch;
}) {
  const tokenUsageRuntime = createTokenUsageRuntime({
    getStore: () => input.tokenUsageStore,
    appendLog: input.appendLog
  });
  const modelPriceSync = createModelPriceSync({
    store: input.tokenUsageStore,
    now: () => input.time.now().date,
    fetch: input.modelCatalogFetch,
    appendLog: input.appendLog
  });
  setOpenAICallObserver(recordGatewayCall);
  setOpenAIStreamLoopObserver(recordStreamLoop);

  const llmLogRuntime = createLLMLogRuntime({
    time: input.time,
    requestLogs: input.requestLogs,
    responseLogs: input.responseLogs,
    ensureActiveSession: (time, agentId = "chat") => input.agentLoopRuntime.ensureCurrentLLMSession(time, agentId),
    getActiveSession: () => input.agentLoopRuntime.getActiveMainLLMSession(),
    noteRequest: (entry, agentId, transcriptMessages) => input.agentLoopRuntime.noteLLMRequest(entry, agentId, transcriptMessages),
    noteResponse: (entry) => input.agentLoopRuntime.noteLLMResponse(entry),
    resolveModel: (agentId) => agentId === "talk" ? input.resolvePromptApiPreset("talk")?.model : input.resolvePromptApiPreset("chat")?.model
  });

  return {
    llmLogRuntime,
    recordTokenUsageEvent,
    appendLLMUsageLog: tokenUsageRuntime.appendLLMUsageLog,
    getTokenUsageReport: tokenUsageRuntime.getTokenUsageReport
  };

  function recordTokenUsageEvent(event: Parameters<typeof tokenUsageRuntime.recordTokenUsageEvent>[0]) {
    const stored = tokenUsageRuntime.recordTokenUsageEvent(event);
    if (stored) {
      try {
        input.tokenUsageStore.assignProviderId(stored.id, UNKNOWN_PROVIDER_ID);
      } catch (error) {
        warnUsageFailure("token usage provider assignment failed", error);
      }
    }
    void modelPriceSync.refreshCatalogIfExpired().catch((error) => {
      warnUsageFailure("model catalog refresh failed", error);
    });
    return stored;
  }

  async function recordGatewayCall(event: OpenAICallEvent): Promise<void> {
    try {
      const observedAt = input.time.now();
      const model = event.responseModel ?? event.requestedModel;
      const stored = tokenUsageRuntime.recordTokenUsageEvent({
        createdAt: observedAt.iso,
        createdAtUtc: observedAt.date.toISOString(),
        agentId: event.agentId,
        model,
        result: {
          id: event.responseId,
          model,
          finishReason: event.finishReason,
          message: { role: "assistant", content: "" },
          usage: event.usage,
          raw: event.rawUsage ? { usage: event.rawUsage } : undefined
        }
      });
      if (!stored) return;
      try {
        const match = model
          ? await modelPriceSync.recordModelPrice({ baseURL: event.baseURL, model }, observedAt.date.toISOString())
          : (await modelPriceSync.refreshCatalogIfExpired(), undefined);
        input.tokenUsageStore.assignProviderId(stored.id, match?.providerId ?? UNKNOWN_PROVIDER_ID);
      } catch (error) {
        try {
          input.tokenUsageStore.assignProviderId(stored.id, UNKNOWN_PROVIDER_ID);
        } catch (assignmentError) {
          warnUsageFailure("token usage provider assignment failed", assignmentError);
        }
        warnUsageFailure("model price lookup failed", error);
      }
    } catch (error) {
      warnUsageFailure("LLM usage observation failed", error);
    }
  }

  function recordStreamLoop(event: OpenAIStreamLoopEvent): void {
    input.appendLog(
      "warn",
      `LLM stream output loop detected: agent=${event.agentId} protocol=${event.protocol} model=${event.requestedModel ?? "unknown"} phrase_characters=${event.phraseCharacters} repetitions=${event.repetitions} phrase=${JSON.stringify(event.phrase)}`
    );
  }

  function warnUsageFailure(message: string, error: unknown): void {
    try {
      input.appendLog("warn", `${message}: ${error instanceof Error ? error.message : String(error)}`);
    } catch {}
  }
}
