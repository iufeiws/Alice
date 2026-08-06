import type { PiInvocation, PiInvocationCompletion, PiSessionListEntry, PiSessionReadResult, PiSessionReadView, PiSessionSnapshot, PiToolExecutionResult, PiWorkerClient, PiWorkerHealth } from "./contracts.js";

export function createPiWorkerHttpClient(input: { baseURL: string; token?: string; fetchImpl?: typeof fetch }): PiWorkerClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseURL = input.baseURL.replace(/\/+$/, "");
  const authHeaders: Record<string, string> = input.token ? { authorization: `Bearer ${input.token}` } : {};

  return {
    configure(body) {
      return request<{ ok: true }>("/config", { method: "POST", body });
    },
    health(signal) {
      return request<PiWorkerHealth>("/health", { method: "GET", signal });
    },
    executeTool(body) {
      const errorCode = body.toolName === "bash" ? "shell_tool_request_failed" : "file_tool_request_failed";
      return request<PiToolExecutionResult>("/tools/execute", { method: "POST", body, signal: body.signal }, errorCode);
    },
    startInvocation(body) {
      return request<PiInvocation>("/invocations", { method: "POST", body, signal: body.signal });
    },
    sendInvocation(sessionId, body) {
      return request<PiInvocation>(`/sessions/${encodeURIComponent(sessionId)}/send`, { method: "POST", body, signal: body.signal });
    },
    listSessions(signal) {
      return request<PiSessionListEntry[]>("/sessions", { method: "GET", signal });
    },
    readSession(sessionId, view, signal) {
      const suffix = view ? `?view=${encodeURIComponent(view)}` : "";
      return request<PiSessionReadResult>(`/sessions/${encodeURIComponent(sessionId)}${suffix}`, { method: "GET", signal });
    },
    sessionStatus(sessionId, signal) {
      return request<PiSessionSnapshot>(`/sessions/${encodeURIComponent(sessionId)}/status`, { method: "GET", signal });
    },
    waitSession(sessionId, timeoutSeconds, signal) {
      return request<PiSessionSnapshot>(`/sessions/${encodeURIComponent(sessionId)}/wait`, { method: "POST", body: { timeoutSeconds }, signal });
    },
    cancelSession(sessionId, signal) {
      return request<PiSessionSnapshot>(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", signal });
    },
    forkSession(sessionId, entryId, signal) {
      return request<{ sessionId: string }>(`/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: { entryId }, signal });
    },
    previewSession(body) {
      return request<{ sessionId: string; systemPrompt: string }>("/preview", { method: "POST", body, signal: body.signal });
    },
    reconcileInvocations(signal) {
      return request<PiInvocationCompletion[]>("/reconcile", { method: "POST", signal });
    }
  };

  async function request<T>(path: string, init: { method: string; body?: unknown; signal?: AbortSignal }, errorCode = "pi_worker_request_failed"): Promise<T> {
    const headers: Record<string, string> = { ...authHeaders };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${baseURL}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(stripSignal(init.body)),
      signal: init.signal
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = text;
    }
    if (!response.ok) throw new Error(`${errorCode}:${response.status}:${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
    return payload as T;
  }
}

function stripSignal(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { signal: _signal, ...rest } = value as Record<string, unknown>;
  return rest;
}
