import { createLLMRequests } from "./llm-requests.js";
import { cloneLLMMessage, cloneLLMMessages } from "../../../contexts/llm-session/src/adapters/jsonl-llm-session-log.js";
import type { LLMRequestLogEntry } from "../../../contexts/llm-session/src/index.js";
import { createLLMSessionStore, type LLMSessionStore } from "../../../contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import { createId } from "../../../shared/uuid/src/index.js";
import type { LLMChatInput, LLMChatResult, LLMMessage } from "./index.js";
import type { LLMToolLoopRoundRequest } from "./llm-tool-loop.js";

/**
 * SubAgent 会话转录的 SQLite 独立库存储。
 *
 * subagentSessionRoot 是 llm-subagent-sessions.sqlite 的库文件路径(不再是 JSONL 目录);
 * 与主库完全独立: 不共用事务、不共用 current pointer。
 *
 * 转录语义与旧 JSONL logger(applyTranscriptLoggerEntry)对齐:
 *   - request        全量替换 messages(reason=subagent_request)
 *   - response       追加 message(append)
 *   - final_messages 全量替换 messages(reason=subagent_final)
 * meta 为完整可变对象(agent/requestCount/responseCount/currentRound/
 * latestRequest/latestResponse/metadata 等), 整体序列化进 meta_json, 不展开。
 *
 * 故障隔离: 库打开、建表或写入任何失败 → appendLog("error", ...) 记录 degraded,
 * SubAgent LLM 调用继续; 错误绝不加入 prompt/transcript/tool result,
 * 不创建 JSONL fallback; 后续调用可重新尝试存储, 失败期间缺失的 transcript 不补写。
 */
export function createLLMRequestsRuntime(input: {
  getTool(name: string): any;
  appendLLMRequestLog(request: any, agentId?: "chat" | "talk"): LLMRequestLogEntry | undefined;
  appendLLMResponseLog(result: any, agentId?: "chat" | "talk", request?: LLMRequestLogEntry): void;
  appendLLMUsageLog(result: any, model?: string): void;
  recordTokenUsageEvent(event: any): void;
  time: any;
  resolvePromptApiPreset(agentId: "chat" | "talk" | "memorize"): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  // SubAgent 会话库文件路径(llm-subagent-sessions.sqlite); 缺省时不写 SubAgent 转录。
  subagentSessionRoot?: string;
  // SubAgent 会话 SQLite 存储(独立于主库), 测试注入用; 缺省按 subagentSessionRoot 打开。
  subagentSessionStore?: LLMSessionStore;
  agentState?: {
    suspendInactivityTimer(): unknown;
    restartInactivityTimer(): unknown;
  };
}) {
  const requestLogEntries = new WeakMap<object, LLMRequestLogEntry>();
  const subagentRequestSessions = new WeakMap<object, { append(entry: unknown): void }>();
  // 延迟递交的 response 结果: deferResponseTranscript 时暂存, 由 flushResponseTranscript 递交最终版本。
  const deferredResponses = new WeakMap<object, LLMChatResult>();
  // SubAgent 库连接: 惰性打开一次, 打开失败后续调用可重试(不缓存失败状态)。
  let subagentStore: LLMSessionStore | undefined;

  const requests = createLLMRequests({
    getTool: input.getTool,
    onRequestPrepared(requestInput, request) {
      if (isMainAgent(requestInput.agentId)) input.agentState?.suspendInactivityTimer();
      if (requestInput.agentId === "chat" || requestInput.agentId === "talk") {
        const entry = input.appendLLMRequestLog(request, requestInput.agentId);
        if (entry) requestLogEntries.set(requestInput, entry);
        return;
      }
      const session = createSubagentSession(requestInput, requestInput.agentId, requestInput.metadata);
      session?.append({ type: "request", round: requestInput.round, request });
    },
    onResponseReceived(requestInput, request, result) {
      if (requestInput.agentId === "chat" || requestInput.agentId === "talk") {
        if (requestInput.deferResponseTranscript) {
          // 延迟递交: response 消息由调用方在格式化(transform)完成后通过
          // flushResponseTranscript 递交最终版本, 保证与提交的 transcript 一致。
          deferredResponses.set(requestInput, result);
          return;
        }
        input.appendLLMResponseLog(result, requestInput.agentId, requestLogEntries.get(requestInput));
        return;
      }
      subagentRequestSessions.get(requestInput)?.append({ type: "response", round: requestInput.round, response: result });
      clearSubagentSession(requestInput);
      input.appendLLMUsageLog(result, result.model ?? request.model);
      const createdTime = input.time.now();
      input.recordTokenUsageEvent({
        createdAt: createdTime.iso,
        createdAtUtc: createdTime.date.toISOString(),
        agentId: requestInput.agentId,
        model: result.model ?? request.model,
        result
      });
    },
    onRequestSettled(requestInput) {
      if (isMainAgent(requestInput.agentId)) input.agentState?.restartInactivityTimer();
      if (requestInput.agentId !== "chat" && requestInput.agentId !== "talk") clearSubagentSession(requestInput);
    },
    onLog(event) {
      const mode = event.stream ? "stream" : "non-stream";
      const fallbackModel = event.agentId === "memorize"
        ? input.resolvePromptApiPreset("memorize")?.model
        : input.resolvePromptApiPreset("chat")?.model;
      if (event.kind === "call_start") {
        input.appendLog("info", `llm call start: agent=${event.agentId} round=${event.round} mode=${mode} model=${event.model ?? fallbackModel}`);
      }
      if (event.kind === "stream_start") input.appendLog("info", `llm stream start: agent=${event.agentId} round=${event.round} model=${event.model ?? fallbackModel}`);
      if (event.kind === "stream_end") input.appendLog("info", `llm stream end: agent=${event.agentId} round=${event.round} model=${event.model ?? fallbackModel}`);
      if (event.kind === "response_received") input.appendLog("info", `llm response received: agent=${event.agentId} round=${event.round} mode=${mode} model=${event.model ?? fallbackModel}`);
    }
  });

  /**
   * 格式化(transform)完成后递交最终 response 消息。
   * 暂存的 entry 基础数据(id/time/usage 等)保持不变, 仅消息替换为最终版本,
   * 与后续 onMessagesChanged 提交的 transcript 完全一致。
   */
  function flushResponseTranscript(flushInput: { round: number; result: LLMChatResult; request: LLMToolLoopRoundRequest }): void {
    const result = deferredResponses.get(flushInput.request);
    if (!result) return;
    deferredResponses.delete(flushInput.request);
    if (isMainAgent(flushInput.request.agentId)) {
      input.appendLLMResponseLog({ ...result, message: flushInput.result.message }, flushInput.request.agentId, requestLogEntries.get(flushInput.request));
    }
  }

  return { ...requests, flushResponseTranscript };

  function isMainAgent(agentId: string): agentId is "chat" | "talk" {
    return agentId === "chat" || agentId === "talk";
  }

  function createSubagentSession(requestInput: object, agentId: string, metadata: Record<string, unknown> | undefined): { append(entry: unknown): void } | undefined {
    if (!input.subagentSessionRoot && !input.subagentSessionStore) return undefined;
    // 记忆归纳(memorize)已有自己的 llm-sessions/memorize 会话转录,
    // 不重复写入 sub_agent/memorize, 避免同一轮记忆整理产生两份存档。
    if (agentId === "memorize") return undefined;
    const existing = subagentRequestSessions.get(requestInput);
    if (existing) return existing;
    const started = input.time.now();
    const state: SubagentSessionState = {
      sessionId: createId("subagent"),
      agentId,
      metadata: metadata ?? {},
      messages: [],
      startedAt: started.iso,
      startedAtUtc: started.date.toISOString(),
      updatedAt: started.iso,
      updatedAtUtc: started.date.toISOString(),
      requestCount: 0,
      responseCount: 0,
      stored: false
    };
    const session = { append: (entry: unknown) => appendSubagentEntry(state, entry) };
    subagentRequestSessions.set(requestInput, session);
    return session;
  }

  function clearSubagentSession(requestInput: object): void {
    const session = subagentRequestSessions.get(requestInput);
    if (!session) return;
    subagentRequestSessions.delete(requestInput);
  }

  /** 与 applyTranscriptLoggerEntry 对齐的 SubAgent 转录状态更新 + 落库。 */
  function appendSubagentEntry(state: SubagentSessionState, entry: unknown): void {
    if (!entry || typeof entry !== "object") return;
    const raw = entry as Record<string, unknown>;
    const now = input.time.now();
    const time = now.iso;
    const timeUtc = now.date.toISOString();
    const round = typeof raw.round === "number" ? raw.round : Math.max(0, state.requestCount - 1);
    if (raw.type === "request" && raw.request && typeof raw.request === "object") {
      const request = raw.request as LLMChatInput;
      state.messages = cloneLLMMessages(request.messages ?? []);
      state.requestCount = Math.max(state.requestCount, round + 1);
      state.updatedAt = time;
      state.updatedAtUtc = timeUtc;
      state.currentRound = {
        status: "running",
        round,
        startedAt: time,
        startedAtUtc: timeUtc,
        model: request.model,
        temperature: request.temperature,
        tools: request.tools,
        extraParams: request.extraParams
      };
      state.latestRequest = {
        time,
        timeUtc,
        round,
        model: request.model,
        temperature: request.temperature,
        tools: request.tools,
        extraParams: request.extraParams,
        messageCount: state.messages.length
      };
      writeSubagentTranscript(state, "replace", state.messages, "subagent_request");
      return;
    }
    if (raw.type === "response" && raw.response && typeof raw.response === "object") {
      const response = raw.response as LLMChatResult;
      state.responseCount = Math.max(state.responseCount, round + 1);
      state.updatedAt = time;
      state.updatedAtUtc = timeUtc;
      const message = cloneLLMMessage(response.message);
      state.messages.push(message);
      state.currentRound = {
        ...(state.currentRound ?? { round, startedAt: time }),
        status: "finished",
        round,
        finishedAt: time,
        finishedAtUtc: timeUtc
      };
      state.latestResponse = {
        time,
        timeUtc,
        round,
        finishReason: response.finishReason,
        usage: response.usage,
        toolCallCount: response.message.toolCalls?.length ?? 0
      };
      writeSubagentTranscript(state, "append", [message]);
      return;
    }
    if (raw.type === "final_messages" && Array.isArray(raw.messages)) {
      state.messages = cloneLLMMessages(raw.messages as LLMMessage[]);
      state.updatedAt = time;
      state.updatedAtUtc = timeUtc;
      writeSubagentTranscript(state, "replace", state.messages, "subagent_final");
    }
  }
  /** 惰性打开 SubAgent 库; 打开失败记录 error 并返回 undefined, 后续调用可重试。 */
  function getSubagentStore(): LLMSessionStore | undefined {
    if (subagentStore) return subagentStore;
    if (input.subagentSessionStore) {
      subagentStore = input.subagentSessionStore;
      return subagentStore;
    }
    if (!input.subagentSessionRoot) return undefined;
    try {
      subagentStore = createLLMSessionStore(input.subagentSessionRoot);
    } catch (error) {
      subagentStore = undefined;
      input.appendLog("error", `subagent session storage degraded, transcript not persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
    return subagentStore;
  }

  /** 写入 SubAgent 库; 任何失败只记录 error, 不中断 LLM 调用、不写 JSONL fallback。 */
  function writeSubagentTranscript(state: SubagentSessionState, operation: "append" | "replace", messages: LLMMessage[], reason?: string): void {
    const store = getSubagentStore();
    if (!store) return;
    const meta = buildSubagentMeta(state);
    try {
      if (!state.stored) {
        store.create({
          sessionId: state.sessionId,
          agentType: state.agentId,
          startedAt: state.startedAt,
          startedAtUtc: state.startedAtUtc,
          meta,
          messages: state.messages
        });
        state.stored = true;
        return;
      }
      if (operation === "append") {
        // append 只追加消息与 message_count 列; meta 更新由 updateMeta 单独事务负责。
        store.append({ sessionId: state.sessionId, messages });
        store.updateMeta({ sessionId: state.sessionId, meta });
      } else {
        store.replace({ sessionId: state.sessionId, messages, meta, reason: reason ?? "subagent_update" });
      }
    } catch (error) {
      input.appendLog("error", `subagent session storage degraded, transcript not persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function buildSubagentMeta(state: SubagentSessionState): Record<string, unknown> {
    return {
      type: "llm_subagent_session",
      schemaVersion: 1,
      agent: state.agentId,
      startedAt: state.startedAt,
      startedAtUtc: state.startedAtUtc,
      updatedAt: state.updatedAt,
      updatedAtUtc: state.updatedAtUtc,
      requestCount: state.requestCount,
      responseCount: state.responseCount,
      currentRound: state.currentRound,
      latestRequest: state.latestRequest,
      latestResponse: state.latestResponse,
      metadata: state.metadata
    };
  }
}

type SubagentSessionState = {
  sessionId: string;
  agentId: string;
  metadata: Record<string, unknown>;
  messages: LLMMessage[];
  startedAt: string;
  startedAtUtc: string;
  updatedAt: string;
  updatedAtUtc: string;
  requestCount: number;
  responseCount: number;
  currentRound?: Record<string, unknown>;
  latestRequest?: Record<string, unknown>;
  latestResponse?: Record<string, unknown>;
  stored: boolean;
};
