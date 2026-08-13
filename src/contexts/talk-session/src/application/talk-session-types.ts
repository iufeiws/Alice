import type { LLMMessage } from "../../../../contexts/llm-gateway/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { MainAgentClearAcquisition } from "../../../agent-loop/src/runtime/agent-loop-runtime.js";
import type { SessionClearCoordinator, SessionClearResult } from "../../../llm-session/src/application/session-clear-coordinator.js";
import type {
  TalkEvent,
  TalkOutputChunk,
  TalkOutputInterrupt,
  TalkSource,
  TalkStore
} from "../adapters/sqlite-talk-session-store.js";

export type TalkRuntime = {
  store: TalkStore;
  openSession(input: TalkSessionOpenInput): TalkSessionOpenResult;
  closeSession(input: { sessionId: number; occurredAt?: string; occurredAtUtc?: string }): Promise<SessionClearResult>;
  markAgentLoopReady(sessionId: number): void;
  claimReadyAgentLoopSession(): number | undefined;
  prepareReadyAgentLoopSession(sessionId: number, options?: { signal?: AbortSignal; agentLoopRunSeq?: number }): Promise<unknown> | unknown;
  ingestInput(event: TalkEvent): void;
  commitStableInputBatch(batch: StableInputBatch): void;
  appendAssistantDelta(input: { sessionId: number; outputId: string; delta: string }): void;
  finishAssistantOutput(input: { sessionId: number; outputId: string }): void;
  claimBufferedOutputText(sessionId: number): { outputId: string; sessionId: number; text: string; status: "streaming" | "finished" } | undefined;
  claimReadyOutputChunk(sessionId: number): TalkOutputChunk | undefined;
  isSessionOutputIdle(sessionId: number): boolean;
  isForegroundPlaybackIdle(sessionId: number): boolean;
  markForegroundPlaybackIdle(input: { sessionId: number }): void;
  markOutputChunkPlayed(input: { sessionId: number; chunkId: string }): void;
  interruptOutput(input: {
    sessionId: number;
    outputId: string;
    reason: "barge_in" | "manual" | "network" | "unknown";
    elapsedMs?: number;
    totalMs?: number;
    breakpointContext?: { beforeText?: string; afterText?: string };
    omitAssistantMessage?: boolean;
    breakMarker?: string;
  }): TalkOutputInterrupt;
  interruptLatestOutput(input: {
    sessionId: number;
    reason: "barge_in" | "manual" | "network" | "unknown";
    elapsedMs?: number;
    totalMs?: number;
    breakpointContext?: { beforeText?: string; afterText?: string };
    omitAssistantMessage?: boolean;
    breakMarker?: string;
  }): TalkOutputInterrupt | undefined;
  interruptAgentLoop(sessionId: number, input?: { reason?: string; interruptEpoch?: number }): void;
  setLoopPrefixMessageCount(sessionId: number, count: number): void;
  buildNextLoopMessagePatch(sessionId: number, options?: { supportsAudio?: boolean }): TalkLoopMessagePatch;
};

export type TalkLoopMessagePatch = {
  replaceFrom: number;
  messages: LLMMessage[];
};

export type TalkSessionOpenInput = {
  sessionId?: number;
  source: TalkSource;
  occurredAt?: string;
  occurredAtUtc?: string;
  metadata?: unknown;
};

export type TalkSessionOpenResult = {
  sessionId: number;
};

export type StableInputBatch = {
  sessionId: number;
  batchId: string;
  interruptEpoch: number;
  inputs: StableInputItem[];
};

export type StableInputItem = {
  interruptId: string;
  sequence: number;
  reason: "barge_in" | "manual" | "asr_failure" | "call_close";
  asrStreamId?: string;
  text: string;
  audio?: TalkAudioInputPayload;
  occurredAt: string;
  occurredAtUtc?: string;
  targetOutputId?: string;
  targetChunkId?: string;
};

export type TalkAudioInputPayload = {
  kind: "audio";
  data: string;
  format: string;
  mimeType?: string;
  sampleRateHz?: number;
  channels?: number;
  encoding?: string;
  bytes?: number;
  durationMs?: number;
};

export type TalkRuntimeDeps = {
  store: TalkStore;
  time: CurrentTimeProvider;
  breakMarker?: string;
  readyChars?: number;
  /**
   * 统一 Session Clear 协调器（§6 / §7.2）。必填: closeSession 一律走协调器,
   * Short Memory 采集成功后才执行关闭五步, 不存在绕过采集的兼容 fallback。
   */
  sessionClearCoordinator: SessionClearCoordinator;
  /**
   * Main Agent 统一占用获取口(§7.2/§10): closeSession 在转交 coordinator 前获取
   * clearing 占用(kind "talk"), 完整结束(成功或失败)后释放; 与 Chat/Memorize 清除互斥。
   * 必填依赖，禁止缺失时绕过占用。
   */
  acquireMainAgentClear(input: { kind: "chat" | "talk" | "memorize"; sessionId: string }): MainAgentClearAcquisition;
  /** clear() 回调步骤①: 将活跃 Talk LLM transcript 从 runtime 重写到持久存储。 */
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: number): void;
  /** clear() 回调步骤②: 将对应 LLM session 标记为 cleared 并清 current pointer。 */
  clearActiveTalkLLMSession(sessionId: number): void;
  createLLMSession?(input: {
    occurredAt: string;
    occurredAtUtc?: string;
    source: TalkSource;
    metadata?: unknown;
  }): number;
  prepareAgentLoop?(sessionId: number, options?: { signal?: AbortSignal; agentLoopRunSeq?: number }): Promise<unknown> | unknown;
  interruptAgentLoop?(sessionId: number, outputId: string): Promise<void> | void;
  onSessionOpened?(sessionId: number): void;
  onSessionClosed?(sessionId: number): void;
};
