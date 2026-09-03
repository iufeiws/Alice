import { Agent } from "undici";
import type { RequestAuthorization } from "./request-authorization.js";

/**
 * Raw OpenAI-compatible upstream transport owned by the LLM gateway.
 *
 * Timeout, retry and Bearer auth live here so callers (e.g. the Pi relay)
 * never re-implement LLM interaction. `cleanup()` releases the internal
 * timeout/abort listeners once the caller is done with the response;
 * `abort()` cancels an in-flight request.
 */
type OpenAIUpstreamRequestInput = {
  path: string;
  init: RequestInit;
  signal?: AbortSignal;
  callContext?: { agentId: string };
};

export type OpenAICallEvent = {
  baseURL: string;
  agentId: string;
  requestedModel?: string;
  responseModel?: string;
  responseId?: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  };
  rawUsage?: Record<string, unknown>;
};

type OpenAICallObserver = (event: OpenAICallEvent) => void | Promise<void>;
let openAICallObserver: OpenAICallObserver | undefined;

export function setOpenAICallObserver(observer: OpenAICallObserver | undefined): void {
  openAICallObserver = observer;
}

export type OpenAIUpstreamAttempt = {
  response: Response;
  cleanup(): void;
  abort(): void;
};

export type OpenAIUpstreamRequest = {
  <T>(input: OpenAIUpstreamRequestInput & { consume(response: Response): Promise<T> }): Promise<T>;
  (input: OpenAIUpstreamRequestInput): Promise<OpenAIUpstreamAttempt>;
};

const openAIRetryDelayMs = 2_000;

export function createOpenAIUpstreamRequester(config: {
  baseURL: string;
  authorization?: RequestAuthorization;
  timeoutMs?: number;
  /** When false (the default), bypass the process-wide outbound proxy. */
  useProxy?: boolean;
  fetchImpl?: typeof fetch;
}): OpenAIUpstreamRequest {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseURL = config.baseURL.replace(/\/+$/, "");
  const authorization = config.authorization;
  const dispatcher = config.useProxy === true ? undefined : newDirectDispatcher();
  return async function requestUpstream<T>(
    input: OpenAIUpstreamRequestInput & { consume?(response: Response): Promise<T> }
  ): Promise<T | OpenAIUpstreamAttempt> {
    let transportRetries = 0;
    let authorizationRetries = 0;
    let forcedAuthorization: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const target = new URL(`${baseURL}${input.path}`);
      const authorizationValue = forcedAuthorization ?? await authorization?.authorization(target);
      forcedAuthorization = undefined;
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (input.signal?.aborted) controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000);
      const cleanup = () => {
        input.signal?.removeEventListener("abort", abort);
        clearTimeout(timeout);
      };

      const requestInit: RequestInit & { dispatcher?: unknown } = {
        ...input.init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(input.init.headers ?? {}),
          ...(authorizationValue ? { authorization: authorizationValue } : {})
        }
      };
      if (dispatcher) requestInit.dispatcher = dispatcher;

      let response: Response;
      try {
        response = await fetchImpl(target.toString(), requestInit);
      } catch (error) {
        cleanup();
        if (transportRetries >= 1 || input.signal?.aborted) throw error;
        transportRetries += 1;
        await sleep(openAIRetryDelayMs, input.signal);
        continue;
      }

      if (response.status === 401 && authorization && authorizationValue && authorizationRetries < 1 && !input.signal?.aborted) {
        const refreshed = await authorization.retryAfterUnauthorized({ target, rejectedAuthorization: authorizationValue });
        if (refreshed) {
          authorizationRetries += 1;
          forcedAuthorization = refreshed;
          cleanup();
          await cancelResponseBody(response);
          continue;
        }
      }

      if (transportRetries < 1 && isRetryableOpenAIStatus(response.status) && !input.signal?.aborted) {
        transportRetries += 1;
        cleanup();
        await cancelResponseBody(response);
        await sleep(openAIRetryDelayMs, input.signal);
        continue;
      }

      if (openAICallObserver && response.ok && (input.path === "/chat/completions" || input.path === "/responses")) {
        try {
          response = observeOpenAICallResponse(response, {
            baseURL,
            agentId: input.callContext?.agentId ?? "llm",
            requestedModel: requestModel(input.init.body)
          });
        } catch {}
      }

      if (!input.consume) {
        return { response, cleanup, abort: () => controller.abort() };
      }

      try {
        const result = await input.consume(response);
        cleanup();
        return result;
      } catch (error) {
        cleanup();
        await cancelResponseBody(response);
        controller.abort();
        if (transportRetries >= 1 || input.signal?.aborted || !response.ok) throw error;
        transportRetries += 1;
        await sleep(openAIRetryDelayMs, input.signal);
      }
    }
    throw new Error("unreachable OpenAI fetch retry state");
  } as OpenAIUpstreamRequest;
}

function observeOpenAICallResponse(response: Response, call: Pick<OpenAICallEvent, "baseURL" | "agentId" | "requestedModel">): Response {
  if (!response.body) {
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await emitOpenAICall(call);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          try {
            await observeCall(chunks, call, sse);
          } catch {}
          controller.close();
          return;
        }
        chunks.push(next.value.slice());
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function observeCall(chunks: Uint8Array[], call: Pick<OpenAICallEvent, "baseURL" | "agentId" | "requestedModel">, sse: boolean): Promise<void> {
  const bytes = concatenateChunks(chunks);
  const text = new TextDecoder().decode(bytes);
  let raw: Record<string, unknown>;
  try {
    raw = sse ? observedSseResult(text) : JSON.parse(text) as Record<string, unknown>;
  } catch {
    await emitOpenAICall(call);
    return;
  }
  const rawUsage = objectValue(raw.usage);
  const firstChoice = Array.isArray(raw.choices) ? objectValue(raw.choices[0]) : undefined;
  await emitOpenAICall({
    ...call,
    responseModel: stringValue(raw.model),
    responseId: stringValue(raw.id),
    finishReason: stringValue(firstChoice?.finish_reason) ?? responsesFinishReason(raw),
    usage: normalizeOpenAIUsage(rawUsage),
    rawUsage
  });
}

async function emitOpenAICall(event: OpenAICallEvent): Promise<void> {
  try {
    await openAICallObserver?.(event);
  } catch {}
}

function observedSseResult(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof chunk.id === "string") result.id = chunk.id;
    if (typeof chunk.model === "string") result.model = chunk.model;
    const usage = objectValue(chunk.usage);
    if (usage) result.usage = usage;
    if (chunk.type === "response.completed" || chunk.type === "response.failed" || chunk.type === "response.incomplete") {
      const response = objectValue(chunk.response);
      if (response) Object.assign(result, response);
    }
    const firstChoice = Array.isArray(chunk.choices) ? objectValue(chunk.choices[0]) : undefined;
    if (typeof firstChoice?.finish_reason === "string") result.choices = [{ finish_reason: firstChoice.finish_reason }];
  }
  return result;
}

function responsesFinishReason(raw: Record<string, unknown>): string | undefined {
  const status = stringValue(raw.status);
  if (status === "completed") return "stop";
  return stringValue(objectValue(raw.incomplete_details)?.reason) ?? status;
}

function requestModel(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const raw = JSON.parse(body) as Record<string, unknown>;
    return stringValue(raw.model);
  } catch {
    return undefined;
  }
}

export function normalizeOpenAIUsage(value: unknown): OpenAICallEvent["usage"] {
  const raw = objectValue(value);
  if (!raw) return undefined;
  const promptDetails = objectValue(raw.prompt_tokens_details);
  const inputDetails = objectValue(raw.input_tokens_details);
  const cacheHitTokens = numberValue(raw.prompt_cache_hit_tokens)
    ?? numberValue(raw.cache_hit_tokens)
    ?? numberValue(promptDetails?.cached_tokens)
    ?? numberValue(inputDetails?.cached_tokens)
    ?? numberValue(inputDetails?.cache_read);
  const inputTokens = numberValue(raw.input_tokens) ?? numberValue(raw.prompt_tokens);
  const outputTokens = numberValue(raw.output_tokens) ?? numberValue(raw.completion_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberValue(raw.total_tokens)
      ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined),
    cacheHitTokens,
    cacheMissTokens: numberValue(raw.prompt_cache_miss_tokens)
      ?? numberValue(raw.cache_miss_tokens)
      ?? (inputTokens !== undefined && cacheHitTokens !== undefined ? Math.max(0, inputTokens - cacheHitTokens) : undefined)
  };
}

function concatenateChunks(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function newDirectDispatcher(): unknown {
  return new Agent();
}

function isRetryableOpenAIStatus(status: number): boolean {
  return status === 502 || status === 503;
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body as { cancel?: () => Promise<void> } | null;
  if (typeof body?.cancel !== "function") return;
  await body.cancel().catch(() => undefined);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
