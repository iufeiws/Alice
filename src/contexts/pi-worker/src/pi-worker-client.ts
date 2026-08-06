import type { PiSession, PiSessionEvent, PiToolExecutionResult, PiWorkerClient, PiWorkerHealth } from "./contracts.js";

export function createPiWorkerHttpClient(input: { baseURL: string; fetchImpl?: typeof fetch }): PiWorkerClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseURL = input.baseURL.replace(/\/+$/, "");

  return {
    health(signal) {
      return request<PiWorkerHealth>("/health", { method: "GET", signal });
    },
    executeTool(body) {
      return request<PiToolExecutionResult>("/tools/execute", { method: "POST", body, signal: body.signal });
    },
    createSession(body) {
      return request<Pick<PiSession, "sessionId" | "status">>("/sessions", { method: "POST", body, signal: body.signal });
    },
    startSession(sessionId, body = {}) {
      return request<Pick<PiSession, "sessionId" | "status">>(`/sessions/${encodeURIComponent(sessionId)}/start`, { method: "POST", body, signal: body.signal });
    },
    previewSession(body) {
      return request<{ sessionId: string; systemPrompt: string }>("/preview", { method: "POST", body, signal: body.signal });
    },
    getSession(sessionId, signal) {
      return request<PiSession>(`/sessions/${encodeURIComponent(sessionId)}`, { method: "GET", signal });
    },
    listSessions(signal) {
      return request<PiSession[]>("/sessions", { method: "GET", signal });
    },
    listSessionEvents(sessionId, cursor, signal) {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return request<{ events: PiSessionEvent[]; nextCursor?: string }>(`/sessions/${encodeURIComponent(sessionId)}/events${suffix}`, { method: "GET", signal });
    },
    cancelSession(sessionId, signal) {
      return request<PiSession>(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", signal });
    },
    markInterrupted(sessionId, signal) {
      return request<PiSession>(`/sessions/${encodeURIComponent(sessionId)}/interrupted`, { method: "POST", signal });
    },
    markCompletionDelivered(sessionId, signal) {
      return request<PiSession>(`/sessions/${encodeURIComponent(sessionId)}/completion-delivered`, { method: "POST", signal });
    }
  };

  async function request<T>(path: string, init: { method: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
    const response = await fetchImpl(`${baseURL}${path}`, {
      method: init.method,
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
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
    if (!response.ok) throw new Error(`pi_worker_request_failed:${response.status}:${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
    return payload as T;
  }
}

function stripSignal(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { signal: _signal, ...rest } = value as Record<string, unknown>;
  return rest;
}
