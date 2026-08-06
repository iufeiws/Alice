import { timingSafeEqual, createHash } from "node:crypto";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { LLMChatResult } from "./index.js";
import type { PiPresetSnapshot } from "./pi-preset-adapter.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const allowedResponseHeaders = ["content-type", "cache-control", "x-request-id", "retry-after"];

export type PiRelayCapability = {
  tokenHash: string;
  sandboxId: string;
  active: boolean;
  expiresAt?: string;
  sessionPresets: Map<string, PiPresetSnapshot>;
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
  createCapability(input: { sandboxId: string; token?: string }): { token: string; capability: PiRelayCapability };
  revokeCapability(token: string): void;
  bindSession(input: { token: string; sessionId: string; preset: PiPresetSnapshot }): void;
  releaseSession(input: { token: string; sessionId: string }): void;
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
}): PiLLMRelay {
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxBodyBytes = input.maxBodyBytes ?? MAX_BODY_BYTES;
  const capabilities = new Map<string, PiRelayCapability>();
  let activeServer: { close(callback: (error?: Error) => void): void } | undefined;

  return {
    createCapability(capabilityInput) {
      const token = capabilityInput.token ?? randomToken();
      const capability = {
        tokenHash: hashToken(token),
        sandboxId: capabilityInput.sandboxId,
        active: true,
        sessionPresets: new Map<string, PiPresetSnapshot>()
      } satisfies PiRelayCapability;
      capabilities.set(capability.tokenHash, capability);
      return { token, capability };
    },
    revokeCapability(token) {
      const hash = hashToken(token);
      const capability = capabilities.get(hash);
      if (capability) capability.active = false;
    },
    bindSession(bindInput) {
      const capability = requireCapability(bindInput.token);
      capability.sessionPresets.set(bindInput.sessionId, Object.freeze({
        ...bindInput.preset,
        extraParams: Object.freeze({ ...bindInput.preset.extraParams })
      }));
    },
    releaseSession(releaseInput) {
      capabilities.get(hashToken(releaseInput.token))?.sessionPresets.delete(releaseInput.sessionId);
    },
    async handle(request) {
      return await handleRelayRequest(request, { capabilities, fetchImpl, maxBodyBytes, time: input.time, recordTokenUsageEvent: input.recordTokenUsageEvent });
    },
    async start() {
      const http = await import("node:http");
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        let size = 0;
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
        }, { capabilities, fetchImpl, maxBodyBytes, time: input.time, recordTokenUsageEvent: input.recordTokenUsageEvent });
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            res.write(next.value);
          }
        }
        res.end();
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

  function requireCapability(token: string): PiRelayCapability {
    const capability = capabilities.get(hashToken(token));
    if (!capability || !capability.active) throw new Error("pi_relay_capability_invalid");
    return capability;
  }
}

async function handleRelayRequest(
  request: Request | PiRelayRequest,
  input: {
    capabilities: Map<string, PiRelayCapability>;
    fetchImpl: typeof fetch;
    maxBodyBytes: number;
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
  if (!capability || !capability.active || (capability.expiresAt && capability.expiresAt <= input.time.now().iso)) return relayError(403, "pi_relay_capability_invalid");
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
  const sessionId = sessionIdFrom(headers, parsed);
  if (!sessionId) return relayError(400, "pi_relay_session_required");
  const preset = capability.sessionPresets.get(sessionId);
  if (!preset) return relayError(403, "pi_relay_session_not_bound");
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), preset.timeoutMs || DEFAULT_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await input.fetchImpl(`${preset.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: headers.get("accept") ?? "application/json",
        authorization: `Bearer ${preset.apiKey}`
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  const response = await forwardResponse(upstream, preset, input);
  return response;
}

async function forwardResponse(response: Response, preset: PiPresetSnapshot, input: { time: CurrentTimeProvider; recordTokenUsageEvent: PiRelayUsageRecorder }): Promise<Response> {
  const responseHeaders = new Headers();
  for (const name of allowedResponseHeaders) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!response.body) return new Response(null, { status: response.status, headers: responseHeaders });
  if (!isSse(response.headers.get("content-type"))) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.ok) recordUsageFromJson(bytes, preset, input);
    return new Response(bytes, { status: response.status, headers: responseHeaders });
  }
  const [clientBody, observerBody] = response.body.tee();
  void observeSseUsage(observerBody, preset, input);
  return new Response(clientBody, { status: response.status, headers: responseHeaders });
}

async function observeSseUsage(body: ReadableStream<Uint8Array>, preset: PiPresetSnapshot, input: { time: CurrentTimeProvider; recordTokenUsageEvent: PiRelayUsageRecorder }): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Record<string, unknown> | undefined;
  let metadata: { id?: string; model?: string; finish_reason?: string } = {};
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
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
    }
  }
  if (buffer.startsWith("data:")) {
    const payload = buffer.slice(5).trim();
    if (payload !== "[DONE]") {
      try {
        const parsed = JSON.parse(payload) as { usage?: Record<string, unknown> | null; model?: string; id?: string; choices?: Array<{ finish_reason?: string }> };
        if (parsed.usage) usage = parsed.usage;
        metadata = { id: parsed.id ?? metadata.id, model: parsed.model ?? metadata.model, finish_reason: parsed.choices?.[0]?.finish_reason ?? metadata.finish_reason };
      } catch {
        // A partial or provider-specific SSE frame is not a usage event.
      }
    }
  }
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
