import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import type {
  ClearableSessionKind,
  SessionClearResult
} from "../../../llm-session/src/application/session-clear-coordinator.js";
import {
  runLLMToolLoop,
  type LLMToolLoopExecution,
  type LLMToolLoopInput,
  type LLMToolLoopResult
} from "../../../llm-gateway/src/llm-tool-loop.js";
import type { AgentEvent, AgentOutput } from "../contracts/agent-contracts.js";
import {
  appendAgentLoopSessionContext,
  clearAgentLoopActiveSessionContext,
  createAgentLoopActiveSessionContext,
  ensureAgentLoopChatSessionContext,
  prepareAgentLoopChatSessionContext,
  prepareAgentLoopSessionContext,
  setAgentLoopActiveSessionContext,
  type AgentLoopAppendSessionContextInput,
  type AgentLoopAppendSessionContextResult,
  type AgentLoopClearActiveSessionContextInput,
  type AgentLoopCreateActiveSessionContextInput,
  type AgentLoopEnsureChatSessionContextInput,
  type AgentLoopMutableSession,
  type AgentLoopPreparedSessionContext,
  type AgentLoopPrepareChatSessionContextInput,
  type AgentLoopPrepareChatSessionContextResult,
  type AgentLoopSessionContextInput,
  type AgentLoopSetActiveSessionContextInput
} from "./agent-loop-session-initializer.js";

export type AgentLoopKind = "chat" | "talk";

export type AgentLoopPhase = "idle" | "running" | "cancelled";

export type ActiveMainLLMSessionState = {
  id: number | string;
  agentId: AgentLoopKind;
  agentLoopRunSeq: number;
  phase: AgentLoopPhase;
};

/**
 * Main Agent 统一运行占用(§7.1/§10/§11.2): requestRun 与统一 clear(Chat/Talk/Memorize)
 * 共用同一占用。clear 开始前获取占用(先占用、后清除), 完整结束(成功或失败)后释放;
 * 占用期间互斥(requestRun 返回 { started:false }, beginClearSession 返回 { acquired:false })。
 */
export type MainAgentActivity =
  | { phase: "idle" }
  | { phase: "running"; kind: "chat" | "talk"; sessionId: string | number }
  | { phase: "clearing"; kind: ClearableSessionKind; sessionId: string };

export type MainAgentClearAcquisition =
  | { acquired: true; token: string; release(): void }
  | { acquired: false };

export type LLMSessionRuntimePort = {
  ensureCurrentLLMSession(time: string, agentId?: AgentLoopKind): { id: number | string };
  createTalkLLMSession(time: string): { id: number | string };
  noteLLMRequest(entry: unknown, agentId: AgentLoopKind, transcriptMessages: LLMChatInput["messages"]): void;
  noteLLMResponse(entry: unknown): void;
  isActiveTalkLLMSession(sessionId: number): boolean;
  loadCurrentLLMSessionTranscript(): unknown;
  updateCurrentLLMSessionTranscript(session: unknown): void;
  updateActiveTalkLLMSessionTranscript(session: unknown): void;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: number): void;
  clearCurrentLLMSession(reason: unknown): Promise<SessionClearResult>;
  /** 直接清除(不经 coordinator、不采集 Short Memory): Talk 关闭回调内部专用。 */
  clearCurrentLLMSessionDirect(reason: unknown): void;
  getCurrentLLMSessionSnapshot?(): unknown;
};

export type AgentLoopChatRunRequest = {
  kind: "chat";
  sessionId: string;
  reason: string;
  event: AgentEvent;
  appendSessionContextAfterFailedRequest?: boolean;
};

export type AgentLoopTalkRunRequest = {
  kind: "talk";
  sessionId: number;
  reason: string;
};

export type AgentLoopRunRequest = AgentLoopChatRunRequest | AgentLoopTalkRunRequest;

export type AgentLoopRunResult = {
  started: boolean;
  outputs: AgentOutput[];
};

export type PreparedAgentLoopRun = {
  spec?: AgentFunctionCallLoopSpec;
  prepare?(): Promise<AgentFunctionCallLoopSpec | AgentOutput[] | void> | AgentFunctionCallLoopSpec | AgentOutput[] | void;
  complete(result: AgentFunctionCallLoopResult): Promise<AgentOutput[] | void> | AgentOutput[] | void;
  onError?(error: unknown): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export type AgentLoopRunners = {
  prepareChat(input: { event: AgentEvent; sessionId: string; reason: string; signal: AbortSignal; agentLoopRunSeq: number; appendSessionContextAfterFailedRequest?: boolean }): Promise<PreparedAgentLoopRun | AgentOutput[]> | PreparedAgentLoopRun | AgentOutput[];
  prepareTalk(input: { sessionId: number; reason: string; signal: AbortSignal; agentLoopRunSeq: number }): Promise<PreparedAgentLoopRun | void> | PreparedAgentLoopRun | void;
};

export type AgentLoopRunSpec = {
  kind: AgentLoopKind;
  agentId: AgentLoopKind;
  sessionId: string | number;
  messages: LLMChatInput["messages"];
};

export type InboundUserMessageInterruptSource = {
  hasPending(sessionId: string): boolean;
  consumeContent(sessionId: string): string | undefined;
  discard(sessionId: string): void;
};

export type AgentLoopRuntime = {
  getActiveMainLLMSession(): ActiveMainLLMSessionState | undefined;
  setInboundUserMessageInterruptSource(source: InboundUserMessageInterruptSource | undefined): void;
  setLLMSessionRuntime(runtime: LLMSessionRuntimePort | undefined): void;
  ensureCurrentLLMSession(time: string, agentId?: AgentLoopKind): { id: number | string };
  createTalkLLMSession(time: string): { id: number | string };
  noteLLMRequest(entry: unknown, agentId: AgentLoopKind, transcriptMessages: LLMChatInput["messages"]): void;
  noteLLMResponse(entry: unknown): void;
  isActiveTalkLLMSession(sessionId: number): boolean;
  loadCurrentLLMSessionTranscript(): unknown;
  updateCurrentLLMSessionTranscript(session: unknown): void;
  updateActiveTalkLLMSessionTranscript(session: unknown): void;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: number): void;
  clearCurrentLLMSession(reason: unknown): Promise<SessionClearResult>;
  clearCurrentLLMSessionDirect(reason: unknown): void;
  getCurrentLLMSessionSnapshot(): unknown;
  isRunning(): boolean;
  isMainAgentBusy(): boolean;
  getMainAgentActivity(): MainAgentActivity;
  beginClearSession(input: { kind: ClearableSessionKind; sessionId: string }): MainAgentClearAcquisition;
  setRunners(runners: Partial<AgentLoopRunners>): void;
  setActiveSessionContext<TSession = unknown>(input: AgentLoopSetActiveSessionContextInput<TSession>): void;
  clearActiveSessionContext<TSession = unknown>(input: AgentLoopClearActiveSessionContextInput<TSession>): boolean;
  createActiveSessionContext<TSession = unknown>(input: AgentLoopCreateActiveSessionContextInput<TSession>): TSession;
  prepareChatSessionContext<TSession = unknown>(input: AgentLoopPrepareChatSessionContextInput<TSession>): Promise<AgentLoopPrepareChatSessionContextResult<TSession>>;
  ensureChatSessionContext<TSession = unknown, TMode = unknown>(input: AgentLoopEnsureChatSessionContextInput<TSession, TMode>): Promise<TSession>;
  prepareSessionContext(input: AgentLoopSessionContextInput): Promise<AgentLoopPreparedSessionContext>;
  appendSessionContext<TSession extends AgentLoopMutableSession>(input: AgentLoopAppendSessionContextInput<TSession>): AgentLoopAppendSessionContextResult<TSession>;
  requestRun(request: AgentLoopRunRequest): Promise<AgentLoopRunResult>;
  interrupt(reason: string): void;
};

export type AgentFunctionCallLoopSpec = LLMToolLoopInput;
export type AgentFunctionCallLoopResult = LLMToolLoopResult;
export type AgentFunctionCallToolExecution = LLMToolLoopExecution;

/** prepare 直接产出 outputs(未跑 function-call loop)时传给 complete 的空 loop 结果。 */
const EMPTY_AGENT_LOOP_RESULT: AgentFunctionCallLoopResult = {
  messages: [],
  rounds: 0,
  finalMessage: { role: "assistant", content: "" },
  stopReason: "empty_messages",
  invalidateSession: false,
  toolCallCount: 0
};

export function createAgentLoopRuntime(input: Partial<AgentLoopRunners> = {}): AgentLoopRuntime {
  let activeMainLLMSession: ActiveMainLLMSessionState | undefined;
  // §7.1/§10: 统一的 Main Agent 运行占用(running / clearing 互斥, idle 为空闲)。
  let activity: MainAgentActivity = { phase: "idle" };
  // 问题 1: 当前 clearing 占用的 owner 身份(token 载体 + 是否内部 clear 链创建)。
  // activity 形态保持契约不变, owner 身份单独记录; token 每次成功获取都全新唯一。
  let clearingOwner: { token: string; internal: boolean } | undefined;
  let clearTokenSeq = 0;
  // 内部 clear 串行队列: 两个内部 clearCurrentLLMSession 并发时第二个排队等待,
  // 第一个 settle 后接续执行, 全程 busy 连续无 idle 空窗(第二个 settle 后才 idle)。
  type InternalClearJob = {
    reason: unknown;
    resolve(result: SessionClearResult): void;
    reject(error: unknown): void;
  };
  let internalClearQueue: InternalClearJob[] = [];
  let internalClearDraining = false;
  // P1(第四版): 外部占用持有期间委托执行的内部 clear 计数(执行中 + 排队中未 settle 数)。
  // 外部句柄 release 时若计数非零, 标记"释放待定"不立即置 idle; 由最后一个委托 job
  // settle 且队列清空时真正置 idle, 保证任何时刻只要存在未 settle 的 clear busy 恒 true。
  let delegatedClearCount = 0;
  let externalReleasePending = false;
  let agentLoopRunSeq = 0;
  let abortController: AbortController | undefined;
  let runners: Partial<AgentLoopRunners> = { ...input };
  let llmSessionRuntime: LLMSessionRuntimePort | undefined;
  let inboundUserMessageInterruptSource: InboundUserMessageInterruptSource | undefined;

  return {
    getActiveMainLLMSession() {
      return activeMainLLMSession ? { ...activeMainLLMSession } : undefined;
    },
    setInboundUserMessageInterruptSource(source) {
      inboundUserMessageInterruptSource = source;
    },
    setLLMSessionRuntime(runtime) {
      llmSessionRuntime = runtime;
    },
    ensureCurrentLLMSession(time, agentId) {
      return requireLLMSessionRuntime().ensureCurrentLLMSession(time, agentId);
    },
    createTalkLLMSession(time) {
      return requireLLMSessionRuntime().createTalkLLMSession(time);
    },
    noteLLMRequest(entry, agentId, transcriptMessages) {
      requireLLMSessionRuntime().noteLLMRequest(entry, agentId, transcriptMessages);
    },
    noteLLMResponse(entry) {
      requireLLMSessionRuntime().noteLLMResponse(entry);
    },
    isActiveTalkLLMSession(sessionId) {
      return llmSessionRuntime?.isActiveTalkLLMSession(sessionId) ?? false;
    },
    loadCurrentLLMSessionTranscript() {
      return llmSessionRuntime?.loadCurrentLLMSessionTranscript();
    },
    updateCurrentLLMSessionTranscript(session) {
      requireLLMSessionRuntime().updateCurrentLLMSessionTranscript(session);
    },
    updateActiveTalkLLMSessionTranscript(session) {
      requireLLMSessionRuntime().updateActiveTalkLLMSessionTranscript(session);
    },
    rewriteActiveTalkLLMSessionFromRuntime(sessionId) {
      requireLLMSessionRuntime().rewriteActiveTalkLLMSessionFromRuntime(sessionId);
    },
    clearCurrentLLMSession(reason) {
      return clearCurrentLLMSessionWithOccupancy(reason);
    },
    clearCurrentLLMSessionDirect(reason) {
      requireLLMSessionRuntime().clearCurrentLLMSessionDirect(reason);
    },
    getCurrentLLMSessionSnapshot() {
      return llmSessionRuntime?.getCurrentLLMSessionSnapshot?.();
    },
    isRunning() {
      // §11.2: run 结束路径(complete 内 await clear)占用交接期间 busy 必须连续,
      // isRunning 与 isMainAgentBusy 同源, 覆盖 running 与 clearing 两种占用。
      return activity.phase !== "idle";
    },
    isMainAgentBusy() {
      return activity.phase !== "idle";
    },
    getMainAgentActivity() {
      return activity;
    },
    beginClearSession(input) {
      // 先占用、后清除: 统一 clear(Chat/Talk/Memorize 共用)在开始前获取 clearing 占用;
      // 已占用(running 或另一 clear)时拒绝, 不排队不等待。
      if (activity.phase !== "idle") return { acquired: false };
      const token = nextClearToken();
      activity = { phase: "clearing", kind: input.kind, sessionId: input.sessionId };
      clearingOwner = { token, internal: false };
      let released = false;
      return {
        acquired: true,
        token,
        release() {
          if (released) return;
          released = true;
          // 问题 1: 只回收自己 token 名下的占用——过期/他人句柄的 release
          // 不得误释放新 owner 的占用; 同一句柄重复 release 幂等。
          if (clearingOwner?.token === token) {
            // P1(第四版): 外部占用期间仍有委托内部 clear 未 settle(执行中或排队中)——
            // 标记"释放待定", 不得提前回落 idle(§11.2: 清除 Promise 完成前不得放行
            // 后续 heartbeat/function-call loop/新会话); 队列全部 drain(委托计数归零
            // 且队列清空)后由最后一个委托 job 的 finally 真正置 idle。
            if (delegatedClearCount > 0) {
              externalReleasePending = true;
              return;
            }
            activity = { phase: "idle" };
            clearingOwner = undefined;
          }
        }
      };
    },
    setRunners(nextRunners) {
      runners = {
        ...runners,
        ...nextRunners
      };
    },
    setActiveSessionContext(input) {
      setAgentLoopActiveSessionContext(input);
    },
    clearActiveSessionContext(input) {
      return clearAgentLoopActiveSessionContext(input);
    },
    createActiveSessionContext(input) {
      return createAgentLoopActiveSessionContext(input);
    },
    prepareChatSessionContext(input) {
      return prepareAgentLoopChatSessionContext({
        ...input,
        updateSession: (session) => {
          input.updateSession?.(session);
        }
      });
    },
    ensureChatSessionContext(input) {
      return ensureAgentLoopChatSessionContext(input);
    },
    prepareSessionContext(input) {
      return prepareAgentLoopSessionContext(input);
    },
    appendSessionContext(input) {
      return appendAgentLoopSessionContext(input);
    },
    async requestRun(request) {
      // §10/§11.2: 占用期间互斥——running 或 clearing 都拒绝新 run。
      if (activity.phase !== "idle") return { started: false, outputs: [] };
      agentLoopRunSeq += 1;
      const runSeq = agentLoopRunSeq;
      activity = { phase: "running", kind: request.kind, sessionId: request.sessionId };
      abortController = new AbortController();
      activeMainLLMSession = {
        id: request.sessionId,
        agentId: request.kind,
        agentLoopRunSeq: runSeq,
        phase: "running"
      };
      try {
        const outputs = await executeRequest(request, abortController.signal, runSeq);
        return { started: true, outputs };
      } finally {
        abortController = undefined;
        if (activeMainLLMSession?.agentLoopRunSeq === runSeq) {
          activeMainLLMSession = {
            ...activeMainLLMSession,
            phase: "idle"
          };
        }
        // §11.2: 若 run 内部(loop 结束路径)已把占用交接给 clear(running→clearing),
        // 占用由 clear 的 finally 释放, 此处不得回到 idle 造成 busy 空窗。
        if (activity.phase === "running") {
          activity = { phase: "idle" };
        }
      }
    },
    interrupt() {
      abortController?.abort();
      if (activeMainLLMSession) {
        activeMainLLMSession = {
          ...activeMainLLMSession,
          phase: "cancelled"
        };
      }
    }
  };

  async function executeRequest(request: AgentLoopRunRequest, signal: AbortSignal, agentLoopRunSeq: number): Promise<AgentOutput[]> {
    if (request.kind === "chat") {
      if (!runners.prepareChat) throw new Error("agent_loop_chat_runner_unavailable");
      return await executePreparedOrOutputs(await runners.prepareChat({
        event: request.event,
        sessionId: request.sessionId,
        reason: request.reason,
        signal,
        agentLoopRunSeq,
        appendSessionContextAfterFailedRequest: request.appendSessionContextAfterFailedRequest
      }), request);
    }
    if (!runners.prepareTalk) throw new Error("agent_loop_talk_runner_unavailable");
    const prepared = await runners.prepareTalk({
      sessionId: request.sessionId,
      reason: request.reason,
      signal,
      agentLoopRunSeq
    });
    if (!prepared) return [];
    return await executePreparedOrOutputs(prepared, request);
  }

  async function executePreparedOrOutputs(prepared: PreparedAgentLoopRun | AgentOutput[], request: AgentLoopRunRequest): Promise<AgentOutput[]> {
    if (Array.isArray(prepared)) return prepared;
    try {
      const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
      if (!spec) return [];
      if (Array.isArray(spec)) {
        // prepare 直接产出 outputs(未跑 loop)时仍调用 complete 完成收尾:
        // §7.1 会话清除可能发生在 loop 结束路径, 不得在 clear Promise 完成前返回;
        // complete 返回 outputs 时以其为准, 否则使用 prepare 的 outputs。
        const completed = await Promise.resolve(prepared.complete(EMPTY_AGENT_LOOP_RESULT));
        return Array.isArray(completed) ? completed : spec;
      }
      const result = await runAgentFunctionCallLoop({
        ...spec,
        runtimeInterrupts: {
          ...spec.runtimeInterrupts,
          hasPendingUserMessage() {
            return inboundUserMessageInterruptSource?.hasPending(String(request.sessionId)) === true
              || spec.runtimeInterrupts?.hasPendingUserMessage() === true;
          },
          consumePendingUserMessageContent() {
            const sessionId = String(request.sessionId);
            const content = inboundUserMessageInterruptSource?.consumeContent(sessionId);
            if (content !== undefined) return content;
            return spec.runtimeInterrupts?.consumePendingUserMessageContent?.();
          },
          discardPendingUserMessage() {
            inboundUserMessageInterruptSource?.discard(String(request.sessionId));
            spec.runtimeInterrupts?.discardPendingUserMessage?.();
          }
        }
      });
      return await Promise.resolve(prepared.complete(result)) ?? [];
    } catch (error) {
      await prepared.onError?.(error);
      throw error;
    } finally {
      await prepared.dispose?.();
    }
  }

  function requireLLMSessionRuntime(): LLMSessionRuntimePort {
    if (!llmSessionRuntime) throw new Error("llm_session_runtime_unavailable");
    return llmSessionRuntime;
  }

  /**
   * 统一 Chat clear(§7.1, 问题 1): 先占用、后清除——在转交 llmSessionRuntime 的 clear
   * 本体(coordinator + Short Memory 采集)启动前进入 chat clearing 占用, settle(成功或
   * 失败)后释放。所有内部 clear(无论 idle / running 交接 / 外部占用)统一进入串行队列,
   * 由 drain 按 owner 身份决定委托、拒绝或占用交接:
   * - idle: 先占用(持自己的 token)后清除, settle 后释放;
   * - 外部 beginClearSession 的 chat 占用(如 force_wake)已持有: 直接委托执行,
   *   不重复占用不丢占用, 释放由外部句柄负责; 排队中的后续内部 clear 同样委托执行,
   *   外部句柄 release 时若仍有委托 job 未 settle 则释放待定, 队列全部 drain 后才 idle;
   * - 另一内部 chat clear 进行中: 排队等待, 第一个 settle 后接续执行, 全程 busy
   *   连续无 idle 空窗(第二个 settle 后才 idle);
   * - running(本 runtime 自己的 loop): 占用交接, busy 连续;
   * - talk/memorize 占用进行中: throw main_agent_clear_in_progress。
   * token 是 owner 身份载体: 判断"是否外部占用"用该占用是否由本调用方创建, 不用 kind。
   */
  function clearCurrentLLMSessionWithOccupancy(reason: unknown): Promise<SessionClearResult> {
    return new Promise((resolve, reject) => {
      internalClearQueue.push({ reason, resolve, reject });
      void drainInternalClearQueue();
    });
  }

  async function drainInternalClearQueue(): Promise<void> {
    if (internalClearDraining) return;
    internalClearDraining = true;
    try {
      while (internalClearQueue.length > 0) {
        const job = internalClearQueue.shift()!;
        try {
          job.resolve(await executeInternalClearJob(job.reason));
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      internalClearDraining = false;
    }
  }

  async function executeInternalClearJob(reason: unknown): Promise<SessionClearResult> {
    // 外部 beginClearSession 的 chat 占用已持有(如 force_wake): 直接委托执行,
    // 不重复占用、不丢占用, 释放由外部句柄负责(问题 1: 以 owner 身份区分, 非 kind)。
    if (activity.phase === "clearing" && clearingOwner && !clearingOwner.internal) {
      if (activity.kind === "chat") {
        // P1(第四版): 委托 job 计入未 settle 计数(外部句柄 release 时据此延后置 idle)。
        // 外部持有者只 await 第一个 job 即可解析, 但后续排队 job 仍委托执行;
        // 外部 release 后(释放待定)由最后一个委托 job 的 finally 真正置 idle——
        // 期间 busy 恒 true、activity 不为 idle, 队列全部 drain 完成才 idle。
        delegatedClearCount += 1;
        try {
          return await requireLLMSessionRuntime().clearCurrentLLMSession(reason);
        } finally {
          delegatedClearCount -= 1;
          // 释放待定 + 委托计数归零 + 队列清空(无后续排队 job): 才允许回到 idle。
          if (externalReleasePending && delegatedClearCount === 0 && internalClearQueue.length === 0) {
            activity = { phase: "idle" };
            clearingOwner = undefined;
            externalReleasePending = false;
          }
        }
      }
      // 另一类清除(talk/memorize)进行中: 拒绝并发清除(单一占用槽)。
      throw new Error("main_agent_clear_in_progress");
    }
    // idle: 先占用、后清除; running: 与 running 占用交接(不回到 idle, busy 连续)。
    // 串行队列保证同一时刻至多一个内部 clear 持有占用, settle 后由 finally 回收。
    const token = nextClearToken();
    const handoffSessionId = activity.phase === "running" ? activity.sessionId : undefined;
    activity = { phase: "clearing", kind: "chat", sessionId: chatClearSessionId(handoffSessionId) };
    clearingOwner = { token, internal: true };
    try {
      return await requireLLMSessionRuntime().clearCurrentLLMSession(reason);
    } finally {
      // settle(成功或失败)后只回收自己 token 名下的占用(幂等 + owner 校验)。
      if (clearingOwner?.token === token) {
        activity = { phase: "idle" };
        clearingOwner = undefined;
      }
    }
  }

  /** 每次成功获取占用都返回全新唯一的 token(owner 身份载体)。 */
  function nextClearToken(): string {
    clearTokenSeq += 1;
    return `main-agent-clear-${clearTokenSeq}`;
  }

  /** chat 清除占用的 sessionId: 优先取当前 LLM 会话 id, 其次 run 交接的会话 id, 最后兜底。 */
  function chatClearSessionId(handoffSessionId: string | number | undefined): string {
    const snapshot = llmSessionRuntime?.getCurrentLLMSessionSnapshot?.();
    if (snapshot && typeof snapshot === "object" && "id" in snapshot) {
      const id = (snapshot as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") return String(id);
    }
    if (handoffSessionId !== undefined) return String(handoffSessionId);
    return "none";
  }
}

export function runAgentFunctionCallLoop(spec: AgentFunctionCallLoopSpec): Promise<AgentFunctionCallLoopResult> {
  return runLLMToolLoop(spec);
}

export * from "./agent-loop-session-initializer.js";
