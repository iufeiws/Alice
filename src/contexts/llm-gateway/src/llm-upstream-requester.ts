/**
 * Raw OpenAI-compatible upstream transport owned by the LLM gateway.
 *
 * Timeout, retry and Bearer auth live here so callers (e.g. the Pi relay)
 * never re-implement LLM interaction. `cleanup()` releases the internal
 * timeout/abort listeners once the caller is done with the response;
 * `abort()` cancels an in-flight request.
 */
export type OpenAIUpstreamRequest = (input: {
  path: string;
  init: RequestInit;
  signal?: AbortSignal;
}) => Promise<{ response: Response; cleanup(): void; abort(): void }>;

const openAIRetryAttempts = 2;
const openAIRetryDelayMs = 2_000;

export function createOpenAIUpstreamRequester(config: {
  baseURL: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): OpenAIUpstreamRequest {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseURL = config.baseURL.replace(/\/+$/, "");
  return async function requestUpstream(input) {
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

      try {
        const response = await fetchImpl(`${baseURL}${input.path}`, {
          ...input.init,
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            ...(input.init.headers ?? {})
          }
        });
        if (attempt < openAIRetryAttempts && isRetryableOpenAIStatus(response.status) && !input.signal?.aborted) {
          cleanup();
          try {
            await response.body?.cancel();
          } catch {
            // Response body may already be closed by the runtime.
          }
          await sleep(openAIRetryDelayMs, input.signal);
          continue;
        }
        return { response, cleanup, abort: () => controller.abort() };
      } catch (error) {
        cleanup();
        if (attempt >= openAIRetryAttempts || input.signal?.aborted) throw error;
        await sleep(openAIRetryDelayMs, input.signal);
      }
    }
    throw new Error("unreachable OpenAI fetch retry state");
  };
}

function isRetryableOpenAIStatus(status: number): boolean {
  return status === 502 || status === 503;
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
