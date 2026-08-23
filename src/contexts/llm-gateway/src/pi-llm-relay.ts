import { timingSafeEqual, createHash } from "node:crypto";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { LLMChatResult } from "./index.js";
import type { PiPresetSnapshot } from "./pi-preset-adapter.js";
import { createOpenAIUpstreamRequester, type OpenAIUpstreamRequest } from "./llm-upstream-requester.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const allowedResponseHeaders = ["content-type", "cache-control", "x-request-id", "retry-after"];

export type PiRelayCapability = {
  tokenHash: string;
  sandboxId: string;
  active: boolean;
  preset: PiPresetSnapshot;
  /** Gateway-owned upstream transport (timeout/retry/auth); the relay never re-implements LLM interaction. */
  requester: OpenAIUpstreamRequest;
};

export type PiRelayUsageRecorder = (input: {
  createdAt: string;
  createdAtUtc?: string;
  agentId: "pi";
  model: string;
  result: LLMChatResult;
}) => void;

export type PiRelayRequest = {
  method?: string;
  url?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
};

export type PiLLMRelay = {
  createCapability(input: { sandboxId: string; preset: PiPresetSnapshot; token?: string }): { token: string; capability: PiRelayCapability };
  revokeCapability(token: string): void;
  handle(request: Request | PiRelayRequest): Promise<Response>;
  start(): Promise<{ close(): Promise<void>; port: number }>;
  stop(): Promise<void>;
};

export function createPiLLMRelay(input: {
  time: CurrentTimeProvider;
  recordTokenUsageEvent: PiRelayUsageRecorder;
  host?: string;
  port?: number;
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  maxConcurrency?: number;
}): PiLLMRelay {
  const maxBodyBytes = input.maxBodyBytes ?? MAX_BODY_BYTES;
  const slots = createConcurrencySlots(input.maxConcurrency ?? 1);
  const capabilities = new Map<string, PiRelayCapability>();
  let activeServer: { close(callback: (error?: Error) => void): void } | undefined;

  return {
    createCapability(capabilityInput) {
      const token = capabilityInput.token ?? randomToken();
      const preset = freezePreset(capabilityInput.preset);
      const capability = {
        tokenHash: hashToken(token),
        sandboxId: capabilityInput.sandboxId,
        active: true,
        preset,
        requester: createOpenAIUpstreamRequester({
          baseURL: preset.baseURL,
          apiKey: preset.apiKey,
          timeoutMs: preset.timeoutMs,
          useProxy: preset.useProxy === true,
          fetchImpl: input.fetchImpl
        })
      } satisfies PiRelayCapability;
      capabilities.set(capability.tokenHash, capability);
      return { token, capability };
    },
    revokeCapability(token) {
      const hash = hashToken(token);
      const capability = capabilities.get(hash);
      if (capability) capability.active = false;
    },
    handle(request) {
      return handleRelayRequest(request, {
        capabilities,
        maxBodyBytes,
        slots,
        time: input.time,
        recordTokenUsageEvent: input.recordTokenUsageEvent
      });
    },
    async start() {
      const http = await import("node:http");
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.byteLength;
            if (size > maxBodyBytes) {
              res.statusCode = 413;
              res.end("request_body_too_large");
              req.destroy();
              return;
            }
            chunks.push(buffer);
          }
          const response = await handleRelayRequest({
            method: req.method,
            url: req.url,
            headers: nodeHeaders(req.headers),
            body: Buffer.concat(chunks)
          }, {
            capabilities,
            maxBodyBytes,
            slots,
            time: input.time,
            recordTokenUsageEvent: input.recordTokenUsageEvent
          });
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          if (response.body) {
            const reader = response.body.getReader();
            let finished = false;
            // The Pi agent may abort mid-stream (session cancel/timeout); the
            // upstream must be torn down so the concurrency slot is released
            // instead of lingering until the relay timeout.
            res.on("close", () => {
              if (!finished) void reader.cancel().catch(() => {});
            });
            try {
              while (true) {
                const next = await reader.read();
                if (next.done) break;
                res.write(next.value);
              }
              res.end();
            } catch (error) {
              // Upstream errors are raised by the LLM gateway requester; surface
              // them as 502 instead of leaving the client hanging.
              if (res.headersSent) {
                res.destroy();
                return;
              }
              res.statusCode = 502;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({
                error: { message: error instanceof Error ? error.message : String(error), type: "pi_relay_upstream_failed" }
              }));
            } finally {
              finished = true;
            }
            return;
          }
          res.end();
        } catch (error) {
          // Upstream errors are raised by the LLM gateway requester; surface
          // them as 502 instead of leaving the client hanging.
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            error: { message: error instanceof Error ? error.message : String(error), type: "pi_relay_upstream_failed" }
          }));
        }
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(input.port ?? 0, input.host ?? "127.0.0.1", () => resolve());
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : input.port ?? 0;
      activeServer = server;
      return {
        port,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => {
          activeServer = undefined;
          error ? reject(error) : resolve();
        }))
      };
    },
    async stop() {
      if (!activeServer) return;
      await new Promise<void>((resolve, reject) => activeServer!.close((error) => error ? reject(error) : resolve()));
      activeServer = undefined;
    }
  };
}

function freezePreset(preset: PiPresetSnapshot): PiPresetSnapshot {
  return Object.freeze({
    ...preset,
    extraParams: Object.freeze({ ...preset.extraParams })
  });
}

function createConcurrencySlots(max: number): { acquire(): boolean; release(): void } {
  let active = 0;
  return {
    acquire() {
      if (active >= max) return false;
      active += 1;
      return true;
    },
    release() {
      active = Math.max(0, active - 1);
    }
  };
}

async function handleRelayRequest(
  request: Request | PiRelayRequest,
  input: {
    capabilities: Map<string, PiRelayCapability>;
    maxBodyBytes: number;
    slots: { acquire(): boolean; release(): void };
    time: CurrentTimeProvider;
    recordTokenUsageEvent: PiRelayUsageRecorder;
  }
): Promise<Response> {
  const method = request instanceof Request ? request.method : request.method ?? "GET";
  const url = request instanceof Request ? request.url : request.url ?? "/";
  const headers = request instanceof Request ? request.headers : new Headers(request.headers);
  if (method === "GET" && new URL(url, "http://pi-relay.local").pathname === "/health") return new Response(JSON.stringify({ ready: true }), { status: 200, headers: { "content-type": "application/json" } });
  if (method !== "POST" || new URL(url, "http://pi-relay.local").pathname !== "/v1/chat/completions") return relayError(404, "pi_relay_route_not_found");
  const token = bearerToken(headers.get("authorization"));
  if (!token) return relayError(401, "pi_relay_capability_required");
  const capability = findCapability(input.capabilities, token);
  if (!capability || !capability.active) return relayError(403, "pi_relay_capability_invalid");
  const preset = capability.preset;
  let body: Buffer;
  try {
    body = await readBody(request, input.maxBodyBytes);
  } catch (error) {
    if (error instanceof Error && error.message === "pi_relay_body_too_large") return relayError(413, error.message);
    throw error;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    return relayError(400, "pi_relay_invalid_json");
  }
  // Session id is diagnostics only; it never participates in authorization.
  const _sessionId = sessionIdFrom(headers, parsed);
  if (parsed.model !== preset.model) return relayError(400, "pi_relay_model_not_allowed");
  const upstreamBody: Record<string, unknown> = {
    ...parsed,
    ...preset.extraParams,
    model: preset.model,
    temperature: preset.temperature,
    ...(preset.maxTokens === undefined ? {} : { max_tokens: preset.maxTokens })
  };
  delete upstreamBody.authorization;
  delete upstreamBody.apiKey;
  delete upstreamBody.baseURL;

  if (!input.slots.acquire()) return relayError(429, "pi_relay_concurrency_limit");
  let response: Response;
  try {
    // Upstream transport (timeout, retry, auth) belongs to the LLM gateway.
    const attempt = await capability.requester({
      path: "/chat/completions",
      init: {
        method: "POST",
        headers: { accept: headers.get("accept") ?? "application/json" },
        body: JSON.stringify(upstreamBody)
      }
    });
    const upstream = attempt.response;
    // cleanup() clears the upstream timeout; it must stay armed until the body
    // is fully consumed so a stalled stream is aborted instead of holding the
    // concurrency slot forever.
    response = await forwardResponse(upstream, preset, input, () => input.slots.release(), attempt.cleanup, attempt.abort);
  } catch (error) {
    input.slots.release();
    throw error;
  }
  return response;
}

async function forwardResponse(
  response: Response,
  preset: PiPresetSnapshot,
  input: { time: CurrentTimeProvider; recordTokenUsageEvent: PiRelayUsageRecorder },
  release: () => void,
  cleanup: () => void,
  abort: () => void
): Promise<Response> {
  const responseHeaders = new Headers();
  for (const name of allowedResponseHeaders) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!response.body) {
    cleanup();
    release();
    return new Response(null, { status: response.status, headers: responseHeaders });
  }
  if (!isSse(response.headers.get("content-type"))) {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.ok) recordUsageFromJson(bytes, preset, input);
      return new Response(bytes, { status: response.status, headers: responseHeaders });
    } finally {
      cleanup();
      release();
    }
  }
  const [clientBody, observerBody] = response.body.tee();
  // The concurrency slot tracks the upstream stream lifetime: it is released
  // when the usage observer finishes (EOF, error, or abort). A client cancel
  // aborts the upstream transport instead, so the slot is not released while
  // an upstream stream is still consuming capacity.
  void observeSseUsage(observerBody, preset, input)
    .catch(() => {
      // Upstream aborted (timeout or client cancel); nothing to record.
    })
    .finally(() => {
      cleanup();
      release();
    });
  return new Response(withClientCancel(clientBody, abort), { status: response.status, headers: responseHeaders });
}

/** Wrap a stream so the client can cancel the upstream transport when it disconnects. */
function withClientCancel(stream: ReadableStream<Uint8Array>, abort: () => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      abort();
      return reader.cancel();
    }
  });
}

type SseMetadata = { id?: string; model?: string; finish_reason?: string };

async function observeSseUsage(body: ReadableStream<Uint8Array>, preset: PiPresetSnapshot, input: { time: CurrentTimeProvider; recordTokenUsageEvent: PiRelayUsageRecorder }): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Record<string, unknown> | undefined;
  let metadata: SseMetadata = {};
  const consumeFrame = (payload: string) => {
    if (payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as { usage?: Record<string, unknown> | null; model?: string; id?: string; choices?: Array<{ finish_reason?: string }> };
      if (parsed.usage) usage = parsed.usage;
      metadata = {
        id: parsed.id ?? metadata.id,
        model: parsed.model ?? metadata.model,
        finish_reason: parsed.choices?.[0]?.finish_reason ?? metadata.finish_reason
      };
    } catch {
      // A partial or provider-specific SSE frame is not a usage event.
    }
  };
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data:")) consumeFrame(line.slice(5).trim());
    }
  }
  if (buffer.startsWith("data:")) consumeFrame(buffer.slice(5).trim());
  if (usage) recordUsage({ ...metadata, usage }, preset, input);
}

function recordUsageFromJson(bytes: Uint8Array, preset: PiPresetSnapshot, input: { time: CurrentTimeProvider; recordTokenUsageEvent: PiRelayUsageRecorder }): void {
  try {
    recordUsage(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>, preset, input);
  } catch {
    // Provider errors and non-JSON bodies have no usage to record.
  }
}

function recordUsage(raw: Record<string, unknown>, preset: PiPresetSnapshot, input: { time: CurrentTimeProvider; recordTokenUsageEvent: PiRelayUsageRecorder }): void {
  const usage = raw.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const value = usage as Record<string, unknown>;
  const time = input.time.now();
  input.recordTokenUsageEvent({
    createdAt: time.iso,
    createdAtUtc: time.date.toISOString(),
    agentId: "pi",
    model: preset.model,
    result: {
      id: typeof raw.id === "string" ? raw.id : undefined,
      model: typeof raw.model === "string" ? raw.model : preset.model,
      finishReason: typeof raw.finish_reason === "string" ? raw.finish_reason : undefined,
      message: { role: "assistant", content: "" },
      usage: normalizeUsage(value),
      raw
    }
  });
}

function normalizeUsage(value: Record<string, unknown>) {
  const cached = number(value.prompt_cache_hit_tokens) ?? number(value.cache_hit_tokens) ?? nestedNumber(value.prompt_tokens_details, "cached_tokens") ?? nestedNumber(value.input_tokens_details, "cache_read");
  const input = number(value.prompt_tokens) ?? number(value.input_tokens);
  const output = number(value.completion_tokens) ?? number(value.output_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: number(value.total_tokens),
    cacheHitTokens: cached,
    cacheMissTokens: number(value.prompt_cache_miss_tokens) ?? number(value.cache_miss_tokens)
  };
}

function nestedNumber(value: unknown, key: string): number | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? number((value as Record<string, unknown>)[key]) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sessionIdFrom(headers: Headers, body: Record<string, unknown>): string | undefined {
  const header = headers.get("x-pi-session-id");
  if (header?.trim()) return header.trim();
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const sessionId = (metadata as Record<string, unknown>).session_id;
    if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
  }
  return undefined;
}

function readBody(request: Request | PiRelayRequest, maxBodyBytes: number): Promise<Buffer> {
  if (request instanceof Request) return request.arrayBuffer().then((body) => {
    if (body.byteLength > maxBodyBytes) throw new Error("pi_relay_body_too_large");
    return Buffer.from(body);
  });
  if (request.body === undefined || request.body === null) return Promise.resolve(Buffer.alloc(0));
  const body = typeof request.body === "string"
    ? Buffer.from(request.body)
    : request.body instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(request.body))
      : Buffer.from(request.body as Uint8Array);
  if (body.byteLength > maxBodyBytes) return Promise.reject(new Error("pi_relay_body_too_large"));
  return Promise.resolve(body);
}

function findCapability(capabilities: Map<string, PiRelayCapability>, token: string): PiRelayCapability | undefined {
  const candidateHash = hashToken(token);
  for (const [hash, capability] of capabilities) {
    if (safeEqual(hash, candidateHash)) return capability;
  }
  return undefined;
}

function bearerToken(value: string | null): string | undefined {
  if (!value?.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length).trim();
  return token || undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isSse(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("text/event-stream") === true;
}

function relayError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "pi_relay_error" } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function nodeHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}
