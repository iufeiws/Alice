import { createLLMSessionStore, type LLMSessionStore } from '../../llm-session/src/adapters/sqlite-llm-session-store.js';
import { cloneLLMMessage, cloneLLMMessages } from '../../llm-session/src/adapters/jsonl-llm-session-log.js';
import { parseZonedIso } from '../../../platform/time/src/index.js';
import type { LLMChatInput, LLMChatResult, LLMMessage } from '../../llm-gateway/src/index.js';
import type { MemoryInductionSession } from './model.js';

const path = await import('node:path');

type AppendLog = (level: 'info' | 'warn' | 'error', message: string) => void;

/**
 * 记忆归纳(memorize)会话转录写入主库 llm-sessions.sqlite 的 llm_messages_memorize 分表。
 *
 * root 是 llm-sessions 目录路径, 主库文件 = {memoryRoot}/llm-sessions.sqlite
 * (path.dirname(root) 即 memoryRoot)。每次 induction 创建独立唯一 session_id,
 * 不写 current pointer(pointer 只属于 chat/talk)。
 *
 * meta 内容与旧 JSONL 格式保持一致(type/agent/mode/target/targets/windowStartAt/
 * windowEndAt/startedAt/updatedAt/requestCount/responseCount/currentRound/
 * latestRequest/latestResponse/clearedAt 等整体进 meta_json, 不含 message 数量);
 * 写入语义与 applyTranscriptLoggerEntry 对齐: request 全量替换,
 * response 追加, final_messages 全量替换。
 *
 * 故障处理: 主库打开/写入失败只记录日志, 不中断记忆归纳 LLM 循环,
 * 不引入新的错误传播(store 不可用时 session 无 append, 归纳照常进行)。
 */

// 模块级主库连接单例: 整个进程只开一个连接, 避免每次归纳重复打开/关闭。
let mainLLMSessionStore: LLMSessionStore | undefined;
let mainLLMSessionStoreDbPath: string | undefined;

function getMainLLMSessionStore(dbPath: string): LLMSessionStore | undefined {
  if (mainLLMSessionStore && mainLLMSessionStoreDbPath === dbPath) return mainLLMSessionStore;
  try {
    mainLLMSessionStore = createLLMSessionStore(dbPath);
    mainLLMSessionStoreDbPath = dbPath;
  } catch {
    mainLLMSessionStore = undefined;
    mainLLMSessionStoreDbPath = undefined;
  }
  return mainLLMSessionStore;
}

export function createMemoryInductionSession(
  root: string | undefined,
  time: string,
  options: { name: string; windowStartAt?: string; windowEndAt: string; timezone: string; nowIso: () => string },
  appendLog?: AppendLog
): MemoryInductionSession {
  const session: MemoryInductionSession = {
    messages: [],
    roundOffset: 0,
    completedTargets: []
  };
  if (!root) return session;
  const dbPath = path.join(path.dirname(root), 'llm-sessions.sqlite');
  const store = getMainLLMSessionStore(dbPath);
  if (!store) {
    appendLog?.('warn', `memorize llm session storage unavailable: ${dbPath}`);
    return session;
  }
  const startedAtUtc = parseZonedIso(time, options.timezone).toISOString();
  const state: MemorizeSessionState = {
    // session_id 为 UTC 毫秒时间戳(与 meta.sessionId 同值), 与主库 chat/talk 的
    // 时间戳身份一致, 避免存储身份与 meta 身份两套并存。
    sessionId: String(Date.parse(startedAtUtc)),
    startedAt: time,
    startedAtUtc,
    updatedAt: time,
    updatedAtUtc: startedAtUtc,
    messages: [],
    requestCount: 0,
    responseCount: 0,
    stored: false
  };
  session.append = (entry) => appendMemorizeEntry(session, state, entry, options, store, appendLog);
  return session;
}

export function clearMemoryInductionSession(session: MemoryInductionSession | undefined, time: string, reason: string): void {
  if (!session || session.clearedAt) return;
  session.clearedAt = time;
  session.clearReason = reason;
  session.activeTarget = undefined;
  session.append?.({ type: 'final_messages', messages: session.messages });
}

/** 与 applyTranscriptLoggerEntry 对齐的记忆归纳转录状态更新 + 写主库。 */
function appendMemorizeEntry(
  session: MemoryInductionSession,
  state: MemorizeSessionState,
  entry: unknown,
  options: { name: string; windowStartAt?: string; windowEndAt: string; timezone: string; nowIso: () => string },
  store: LLMSessionStore,
  appendLog: AppendLog | undefined
): void {
  if (!entry || typeof entry !== 'object') return;
  const raw = entry as Record<string, unknown>;
  const current = options.nowIso();
  const time = current;
  const timeUtc = parseZonedIso(current, options.timezone).toISOString();
  const round = typeof raw.round === 'number' ? raw.round : Math.max(0, state.requestCount - 1);
  if (raw.type === 'request' && raw.request && typeof raw.request === 'object') {
    const request = raw.request as LLMChatInput;
    state.messages = cloneLLMMessages(request.messages ?? []);
    state.requestCount = Math.max(state.requestCount, round + 1);
    state.updatedAt = time;
    state.updatedAtUtc = timeUtc;
    state.currentRound = {
      status: 'running',
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
    writeMemorizeTranscript(session, state, options, store, appendLog, 'replace', state.messages, 'memorize_request');
    return;
  }
  if (raw.type === 'response' && raw.response && typeof raw.response === 'object') {
    const response = raw.response as LLMChatResult;
    state.responseCount = Math.max(state.responseCount, round + 1);
    state.updatedAt = time;
    state.updatedAtUtc = timeUtc;
    const message = cloneLLMMessage(response.message);
    state.messages.push(message);
    state.currentRound = {
      ...(state.currentRound ?? { round, startedAt: time }),
      status: 'finished',
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
    writeMemorizeTranscript(session, state, options, store, appendLog, 'append', [message]);
    return;
  }
  if (raw.type === 'final_messages' && Array.isArray(raw.messages)) {
    state.messages = cloneLLMMessages(raw.messages as LLMMessage[]);
    state.updatedAt = time;
    state.updatedAtUtc = timeUtc;
    writeMemorizeTranscript(session, state, options, store, appendLog, 'replace', state.messages, 'memorize_final');
  }
  // 其他条目类型(memory_commit/memory_limit_error 等)不改变转录内容, 不落库。
}

function memorizeMeta(
  session: MemoryInductionSession,
  state: MemorizeSessionState,
  options: { name: string; windowStartAt?: string; windowEndAt: string; timezone: string; nowIso: () => string }
): Record<string, unknown> {
  const last = state.messages.at(-1);
  return {
    type: 'llm_session',
    schemaVersion: 1,
    sessionId: Date.parse(state.startedAtUtc ?? state.startedAt),
    sessionCreatedAtUtc: state.startedAtUtc,
    agent: 'memorize',
    target: session.activeTarget,
    targets: session.completedTargets,
    windowStartAt: options.windowStartAt,
    windowEndAt: options.windowEndAt,
    startedAt: state.startedAt,
    startedAtUtc: state.startedAtUtc,
    updatedAt: state.updatedAt,
    updatedAtUtc: state.updatedAtUtc,
    requestCount: state.requestCount,
    responseCount: state.responseCount,
    currentRound: state.currentRound,
    latestRequest: state.latestRequest,
    latestResponse: state.latestResponse,
    lastMessageRole: last?.role,
    lastMessageAt: state.updatedAt,
    mode: 'memorize',
    clearedAt: session.clearedAt,
    clearedAtUtc: session.clearedAt ? parseZonedIso(session.clearedAt, options.timezone).toISOString() : undefined,
    clearReason: session.clearReason
  };
}

/** 写入主库 llm_messages_memorize; 失败只记录日志, 不中断记忆归纳循环。 */
function writeMemorizeTranscript(
  session: MemoryInductionSession,
  state: MemorizeSessionState,
  options: { name: string; windowStartAt?: string; windowEndAt: string; timezone: string; nowIso: () => string },
  store: LLMSessionStore,
  appendLog: AppendLog | undefined,
  operation: 'append' | 'replace',
  messages: LLMMessage[],
  reason?: string
): void {
  const meta = memorizeMeta(session, state, options);
  try {
    if (!state.stored) {
      store.create({
        sessionId: state.sessionId,
        agentType: 'memorize',
        startedAt: state.startedAt,
        startedAtUtc: state.startedAtUtc,
        meta,
        messages: state.messages
      });
      state.stored = true;
      return;
    }
    if (operation === 'append') {
      // append 只追加消息与 message_count 列; meta 更新由 updateMeta 单独事务负责。
      store.append({ sessionId: state.sessionId, messages });
      store.updateMeta({ sessionId: state.sessionId, meta });
    } else {
      store.replace({ sessionId: state.sessionId, messages, meta, reason: reason ?? 'memorize_update' });
    }
  } catch (error) {
    appendLog?.('error', `memorize llm session storage degraded, transcript not persisted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type MemorizeSessionState = {
  sessionId: string;
  startedAt: string;
  startedAtUtc: string;
  updatedAt: string;
  updatedAtUtc: string;
  messages: LLMMessage[];
  requestCount: number;
  responseCount: number;
  currentRound?: Record<string, unknown>;
  latestRequest?: Record<string, unknown>;
  latestResponse?: Record<string, unknown>;
  stored: boolean;
};
