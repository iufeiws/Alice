import { timingSafeEqual, createHash } from "node:crypto";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { PiPresetSnapshot } from "./pi-preset-adapter.js";
import { createOpenAIUpstreamRequester, type OpenAIUpstreamRequest } from "./llm-upstream-requester.js";
import { resolveCredentialAuthorization } from "./credential-runtime.js";

const allowedResponseHeaders = ["content-type", "cache-control", "x-request-id", "retry-after"];

export type PiRelayCapability = {
  tokenHash: string;
  sandboxId: string;
  active: boolean;
  preset: PiPresetSnapshot;
  /** Gateway-owned upstream transport (timeout/retry/auth); the relay never re-implements LLM interaction. */
  requester: OpenAIUpstreamRequest;
};

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
  host?: string;
  port?: number;
  fetchImpl?: typeof fetch;
  maxConcurrency?: number;
}): PiLLMRelay {
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
          authorization: resolveCredentialAuthorization(preset.credentialId),
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
        slots,
        time: input.time
      });
    },
    async start() {
      const http = await import("node:http");
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            chunks.push(buffer);
          }
          const response = await handleRelayRequest({
            method: req.method,
            url: req.url,
            headers: nodeHeaders(req.headers),
            body: Buffer.concat(chunks)
          }, {
            capabilities,
            slots,
            time: input.time
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
    slots: { acquire(): boolean; release(): void };
    time: CurrentTimeProvider;
  }
): Promise<Response> {
  const method = request instanceof Request ? request.method : request.method ?? "GET";
  const url = request instanceof Request ? request.url : request.url ?? "/";
  const headers = request instanceof Request ? request.headers : new Headers(request.headers);
  if (method === "GET" && new URL(url, "http://pi-relay.local").pathname === "/health") return new Response(JSON.stringify({ ready: true }), { status: 200, headers: { "content-type": "application/json" } });
  const pathname = new URL(url, "http://pi-relay.local").pathname;
  if (method !== "POST" || (pathname !== "/v1/chat/completions" && pathname !== "/v1/responses")) return relayError(404, "pi_relay_route_not_found");
  const token = bearerToken(headers.get("authorization"));
  if (!token) return relayError(401, "pi_relay_capability_required");
  const capability = findCapability(input.capabilities, token);
  if (!capability || !capability.active) return relayError(403, "pi_relay_capability_invalid");
  const preset = capability.preset;
  const expectedPath = preset.protocol === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
  if (pathname !== expectedPath) return relayError(404, "pi_relay_protocol_mismatch");
  const body = await readBody(request);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    return relayError(400, "pi_relay_invalid_json");
  }
  const upstreamBody: Record<string, unknown> = preset.protocol === "openai-responses" ? {
    ...preset.extraParams,
    ...parsed,
    model: preset.model,
    stream: preset.stream,
    temperature: preset.temperature,
    ...(preset.maxTokens === undefined ? {} : { max_output_tokens: preset.maxTokens })
  } : {
    ...preset.extraParams,
    model: preset.model,
    stream: preset.stream,
    temperature: preset.temperature,
    messages: parsed.messages,
    ...(Object.prototype.hasOwnProperty.call(parsed, "tools") ? { tools: parsed.tools } : {}),
    ...(Object.prototype.hasOwnProperty.call(parsed, "tool_choice") ? { tool_choice: parsed.tool_choice } : {}),
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
      path: preset.protocol === "openai-responses" ? "/responses" : "/chat/completions",
      callContext: { agentId: "pi" },
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
  input: { time: CurrentTimeProvider },
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
      if (response.ok) {
        if (preset.stream === false && preset.protocol === "openai-chat-completions") {
          const sseHeaders = new Headers(responseHeaders);
          sseHeaders.set("content-type", "text/event-stream");
          sseHeaders.set("cache-control", "no-cache");
          return new Response(nonStreamingJsonToSse(bytes, input.time), { status: response.status, headers: sseHeaders });
        }
      }
      return new Response(bytes, { status: response.status, headers: responseHeaders });
    } finally {
      cleanup();
      release();
    }
  }
  const [clientBody, observerBody] = response.body.tee();
  // The concurrency slot tracks the upstream stream lifetime: it is released
  // when the drain finishes (EOF, error, or abort). A client cancel
  // aborts the upstream transport instead, so the slot is not released while
  // an upstream stream is still consuming capacity.
  void drainSseBody(observerBody)
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

async function drainSseBody(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
  }
}

function nonStreamingJsonToSse(bytes: Uint8Array, time: CurrentTimeProvider): string {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pi_relay_non_stream_response_invalid");
  const rawChoice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  if (!rawChoice || typeof rawChoice !== "object" || Array.isArray(rawChoice)) throw new Error("pi_relay_non_stream_choice_missing");
  const choice = rawChoice as Record<string, unknown>;
  const rawMessage = choice.message;
  if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) throw new Error("pi_relay_non_stream_message_missing");
  const message = rawMessage as Record<string, unknown>;
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
  if (!finishReason) throw new Error("pi_relay_non_stream_finish_reason_missing");
  const delta: Record<string, unknown> = {
    role: typeof message.role === "string" ? message.role : "assistant"
  };
  if (typeof message.content === "string") delta.content = message.content;
  for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
    if (typeof message[key] === "string") delta[key] = message[key];
  }
  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = message.tool_calls.map((rawToolCall, index) => {
      if (!rawToolCall || typeof rawToolCall !== "object" || Array.isArray(rawToolCall)) throw new Error("pi_relay_non_stream_tool_call_invalid");
      const toolCall = rawToolCall as Record<string, unknown>;
      const rawFunction = toolCall.function;
      if (!rawFunction || typeof rawFunction !== "object" || Array.isArray(rawFunction)) throw new Error("pi_relay_non_stream_tool_function_missing");
      const toolFunction = rawFunction as Record<string, unknown>;
      return {
        index,
        ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
        type: typeof toolCall.type === "string" ? toolCall.type : "function",
        function: {
          ...(typeof toolFunction.name === "string" ? { name: toolFunction.name } : {}),
          arguments: typeof toolFunction.arguments === "string" ? toolFunction.arguments : JSON.stringify(toolFunction.arguments ?? {})
        }
      };
    });
  }
  const chunk = {
    id: typeof raw.id === "string" ? raw.id : undefined,
    object: "chat.completion.chunk",
    created: typeof raw.created === "number" ? raw.created : Math.floor(time.now().date.getTime() / 1000),
    model: typeof raw.model === "string" ? raw.model : undefined,
    choices: [{
      index: typeof choice.index === "number" ? choice.index : 0,
      delta,
      finish_reason: finishReason
    }],
    ...(raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage) ? { usage: raw.usage } : {})
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

function readBody(request: Request | PiRelayRequest): Promise<Buffer> {
  if (request instanceof Request) return request.arrayBuffer().then((body) => Buffer.from(body));
  if (request.body === undefined || request.body === null) return Promise.resolve(Buffer.alloc(0));
  const body = typeof request.body === "string"
    ? Buffer.from(request.body)
    : request.body instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(request.body))
      : Buffer.from(request.body as Uint8Array);
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
