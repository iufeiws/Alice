import { Agent } from "undici";

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
};

export type OpenAIUpstreamAttempt = {
  response: Response;
  cleanup(): void;
  abort(): void;
};

export type OpenAIUpstreamRequest = {
  <T>(input: OpenAIUpstreamRequestInput & { consume(response: Response): Promise<T> }): Promise<T>;
  (input: OpenAIUpstreamRequestInput): Promise<OpenAIUpstreamAttempt>;
};

const openAIRetryAttempts = 2;
const openAIRetryDelayMs = 2_000;

export function createOpenAIUpstreamRequester(config: {
  baseURL: string;
  apiKey?: string;
  timeoutMs?: number;
  /** When false (the default), bypass the process-wide outbound proxy. */
  useProxy?: boolean;
  fetchImpl?: typeof fetch;
}): OpenAIUpstreamRequest {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseURL = config.baseURL.replace(/\/+$/, "");
  const dispatcher = config.useProxy === true ? undefined : newDirectDispatcher();
  return async function requestUpstream<T>(
    input: OpenAIUpstreamRequestInput & { consume?(response: Response): Promise<T> }
  ): Promise<T | OpenAIUpstreamAttempt> {
    for (let attempt = 1; attempt <= openAIRetryAttempts; attempt += 1) {
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
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          ...(input.init.headers ?? {})
        }
      };
      if (dispatcher) requestInit.dispatcher = dispatcher;

      let response: Response;
      try {
        response = await fetchImpl(`${baseURL}${input.path}`, requestInit);
      } catch (error) {
        cleanup();
        if (attempt >= openAIRetryAttempts || input.signal?.aborted) throw error;
        await sleep(openAIRetryDelayMs, input.signal);
        continue;
      }

      if (attempt < openAIRetryAttempts && isRetryableOpenAIStatus(response.status) && !input.signal?.aborted) {
        cleanup();
        await cancelResponseBody(response);
        await sleep(openAIRetryDelayMs, input.signal);
        continue;
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
        if (attempt >= openAIRetryAttempts || input.signal?.aborted || !response.ok) throw error;
        await sleep(openAIRetryDelayMs, input.signal);
      }
    }
    throw new Error("unreachable OpenAI fetch retry state");
  } as OpenAIUpstreamRequest;
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
