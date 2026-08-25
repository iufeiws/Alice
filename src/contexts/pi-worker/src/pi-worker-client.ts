import type { PiInvocation, PiRawMessage, PiSessionListEntry, PiSessionSnapshot, PiSubAgentResult, PiSubAgentStatus, PiSubAgentWaitResult, PiToolExecutionResult, PiWorkerClient, PiWorkerHealth } from "./contracts.js";

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
    sendInvocation(nickname, body) {
      return request<PiInvocation>(`/sessions/${encodeURIComponent(nickname)}/send`, { method: "POST", body, signal: body.signal });
    },
    listSessions(signal) {
      return request<PiSessionListEntry[]>("/sessions", { method: "GET", signal });
    },
    sessionMessages(nickname, access, signal) {
      return request<PiRawMessage[]>(`/sessions/${encodeURIComponent(nickname)}/messages?access=${encodeURIComponent(access)}`, { method: "GET", signal });
    },
    sessionStatus(nickname, signal) {
      return request<PiSessionSnapshot>(`/sessions/${encodeURIComponent(nickname)}/snapshot`, { method: "GET", signal });
    },
    sessionStatusBySessionId(sessionId, signal) {
      return request<PiSessionSnapshot>(`/sessions-by-id/${encodeURIComponent(sessionId)}/snapshot`, { method: "GET", signal });
    },
    subAgentStatus(nickname, signal) {
      return request<PiSubAgentStatus>(`/sessions/${encodeURIComponent(nickname)}/status`, { method: "GET", signal });
    },
    resultSession(nickname, signal) {
      return request<PiSubAgentResult>(`/sessions/${encodeURIComponent(nickname)}/result`, { method: "GET", signal });
    },
    waitSession(nickname, timeoutSeconds, signal) {
      return request<PiSubAgentWaitResult>(`/sessions/${encodeURIComponent(nickname)}/wait`, { method: "POST", body: { timeoutSeconds }, signal });
    },
    cancelSession(nickname, signal) {
      return request<"cancelled">(`/sessions/${encodeURIComponent(nickname)}/cancel`, { method: "POST", signal });
    },
    forkSession(nickname, entryId, signal) {
      return request<{ sessionId: string; nickname: string }>(`/sessions/${encodeURIComponent(nickname)}/fork`, { method: "POST", body: { entryId }, signal });
    },
    previewSession(body) {
      return request<{ sessionId: string; systemPrompt: string }>("/preview", { method: "POST", body, signal: body.signal });
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
