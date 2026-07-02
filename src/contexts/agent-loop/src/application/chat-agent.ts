import type { LLMChatInput, LLMChatResult, LLMClient } from "../../../llm-gateway/src/index.js";
import type { LLMRequestLogEntry } from "../../../llm-session/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { PolicyEngine } from "../ports/policy.js";
import type { IntentRouter } from "./intent-router.js";
import type { SessionResolver } from "./session-resolver.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { AgentEvent, AgentOutput, ChannelPlugin, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { buildAppendPromptMessagesWithToolResults, buildPromptMessagesWithToolResults, makePromptContext, staticPromptFingerprint, type PromptProfile } from "../../../agent-profile/src/application/build-system-prompt.js";
import type { AgentStateController, AgentStateSnapshot } from "../domain/agent-loop-state.js";
import type { DailyShell } from "../../../agent-profile/src/domain/shell.js";
import type { MemorySnapshot } from "../../../memory/src/memory.js";
import { buildLLMTextVariables, type LLMTextVariables, type LLMTextWakeBoundary } from "../../../agent-profile/src/application/llm-text-renderer.js";
import { deepSeekPriceForModel } from "../../../llm-gateway/src/token-pricing.js";
import type { LLMRequestSender } from "../../../llm-gateway/src/llm-tool-loop.js";
import type { AgentRunIndicator } from "../../../agent-run-indicator/src/index.js";
import {
  agentInitiatedBehaviorPlanFromEvent,
  agentInitiatedTriggerEventFromRaw,
  buildAgentInitiatedBehaviorMessages,
  createAgentInitiatedBehaviorRun,
  defaultAgentInitiatedBehaviorPlans,
  isToolVisibleInPromptProfile,
  resolveAgentInitiatedBehaviorAvailability,
  type AgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorRun
} from "../../../initiative/src/domain/initiated-behavior.js";
import {
  buildFixedPrefixAppendMessages,
  buildWaitChatResumeMessages,
  checkChatCursorFromResult,
  cloneLLMMessages,
  defaultChatAgentModeState,
  estimateMessagesTokens,
  estimateTextTokens,
  findToolPlugin,
  buildChatAgentLoop,
  runPromptToolRequest,
  toolResultText,
  type ChatAgentLoopInput,
  type ChatAgentLoopSession,
  type ChatAgentModeState
} from "./run-chat-loop.js";
import {
  appendAgentLoopSessionContext,
  clearAgentLoopActiveSessionContext,
  createAgentLoopActiveSessionContext,
  ensureAgentLoopChatSessionContext,
  prepareAgentLoopChatSessionContext,
  setAgentLoopActiveSessionContext,
  type AgentFunctionCallLoopSpec,
  type AgentLoopAppendSessionContextInput,
  type AgentLoopAppendSessionContextResult,
  type AgentLoopClearActiveSessionContextInput,
  type AgentLoopCreateActiveSessionContextInput,
  type AgentLoopEnsureChatSessionContextInput,
  type AgentLoopMutableSession,
  type AgentLoopPrepareChatSessionContextInput,
  type AgentLoopPrepareChatSessionContextResult,
  type AgentLoopSetActiveSessionContextInput,
  type PreparedAgentLoopRun
} from "../runtime/agent-loop-runtime.js";

export type LLMSessionClearReason = "prompt_static_changed" | "admin_clear" | "admin_cancel" | "shutdown" | "token_pressure" | "mode_transition" | "mode_timeout";
export type LLMSessionSnapshot = {
  id?: number;
  messages: LLMChatInput["messages"];
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps?: string[];
  agentLoopRunSeq?: number;
  lastTotalTokens?: number;
  lastInputTokens?: number;
  lastUsageModel?: string;
  tokenPressurePreviewBaselines?: Record<string, TokenPressurePreviewBaseline>;
  mode?: string;
  modeStaticMessages?: LLMChatInput["messages"];
  modeStaticTokenEstimate?: number;
  modeStartedAt?: string;
  modeExpiresAt?: string;
  fixedPrefixKind?: string;
  fixedPrefixCursorMessageId?: number;
  waitChatStartedAt?: string;
};

export type TokenPressurePreviewBaseline = {
  inputTokens: number;
  previewTokens: number;
};

export type TokenPressureComparisonInput = {
  lastInputTokens: number;
  baselineInputTokens: number;
  baselinePreviewTokens: number;
  currentPreviewTokens: number;
  cacheHitPrice: number;
  cacheMissPrice: number;
  contextImportance?: number;
  minRebuildTokens?: number;
};

export type TokenPressureComparison = TokenPressureComparisonInput & {
  estimatedCurrentInputTokens: number;
  continuedTokenDelta: number;
  rebuildTokenDelta: number;
  continuedCost: number;
  rebuildCost: number;
  shouldReset: boolean;
};

export function calculateTokenPressureSwitch(input: TokenPressureComparisonInput): TokenPressureComparison {
  const minRebuildTokens = input.minRebuildTokens ?? 50;
  const contextImportance = Number.isFinite(input.contextImportance) && input.contextImportance !== undefined
    ? input.contextImportance
    : 1;
  const previewDelta = Math.max(0, input.currentPreviewTokens - input.baselinePreviewTokens);
  const estimatedCurrentInputTokens = input.baselineInputTokens + previewDelta;
  const continuedTokenDelta = Math.max(0, input.lastInputTokens - input.baselineInputTokens);
  const rebuildTokenDelta = Math.max(minRebuildTokens, estimatedCurrentInputTokens - input.baselineInputTokens);
  const continuedCost = continuedTokenDelta * input.cacheHitPrice;
  const rebuildCost = rebuildTokenDelta * input.cacheMissPrice * contextImportance;
  return {
    ...input,
    minRebuildTokens,
    contextImportance,
    estimatedCurrentInputTokens,
    continuedTokenDelta,
    rebuildTokenDelta,
    continuedCost,
    rebuildCost,
    shouldReset: continuedCost > rebuildCost
  };
}

type ModeState = ChatAgentModeState;

export * from "../../../initiative/src/adapters/json-initiated-behavior-store.js";
export * from "../../../initiative/src/application/evaluate-triggers.js";
export * from "../runtime/agent-heartbeat-runtime.js";
export * from "../runtime/agent-loop-runtime.js";
export * from "../runtime/agent-state-runtime.js";
export * from "../../../llm-gateway/src/llm-requests.js";
export * from "../../../memory/src/memory-console-runtime.js";
export * from "../../../conversation-hub/src/application/ingest-channel-message.js";
export * from "../../../memory/src/sleep-memory-bridge-runtime.js";
export * from "../../../memory/src/sleep-memory-induction-runtime.js";
export * from "../../../talk-session/src/application/talk-session-runtime.js";

type ChatAgentConfig = {
  llm: {
    model: string;
    temperature: number;
    tokenPressureContextImportance: number;
    extraParams: Record<string, unknown>;
    followupExtraParams: Record<string, unknown>;
    stream: boolean;
  };
};

type ChatLLMRuntimeConfig = {
  client?: LLMClient;
  model?: string;
  temperature?: number;
  extraParams?: Record<string, unknown>;
  followupExtraParams?: Record<string, unknown>;
  presetName?: string;
  stream?: boolean;
  supportsImage?: boolean;
  supportsAudio?: boolean;
};

export type ChatAgentDeps = {
  config: ChatAgentConfig;
  llm: LLMClient;
  intentRouter: IntentRouter;
  sessionResolver: SessionResolver;
  policy: PolicyEngine;
  outputRouter: OutputRouter;
  tools?: ToolPlugin[];
  getPromptProfile?: () => PromptProfile;
  getDailyShell?: () => string;
  getDailyShellRaw?: () => DailyShell;
  getAppearanceDescription?: () => string;
  getLibrarySetting?: () => string;
  getMemorySnapshot?: () => MemorySnapshot;
  getWakeBoundary?: () => LLMTextWakeBoundary | undefined;
  getCalendarContext?: () => string | undefined;
  getAvailableSkills?: () => string | undefined;
  state?: AgentStateController;
  time?: CurrentTimeProvider;
  onLLMRequestPrepared?(input: LLMChatInput): LLMRequestLogEntry | undefined | void;
  onLLMResponseReceived?(result: LLMChatResult, request?: LLMRequestLogEntry): void;
  llmRequestSender: LLMRequestSender;
  agentRunIndicator?: AgentRunIndicator;
  onAgentRunIndicatorError?(error: unknown): void;
  appendLoopSessionContext?<TSession extends AgentLoopMutableSession>(input: AgentLoopAppendSessionContextInput<TSession>): AgentLoopAppendSessionContextResult<TSession>;
  setActiveLoopSessionContext?<TSession>(input: AgentLoopSetActiveSessionContextInput<TSession>): void;
  clearActiveLoopSessionContext?<TSession>(input: AgentLoopClearActiveSessionContextInput<TSession>): boolean;
  createActiveLoopSessionContext?<TSession>(input: AgentLoopCreateActiveSessionContextInput<TSession>): TSession;
  prepareChatLoopSessionContext?<TSession>(input: AgentLoopPrepareChatSessionContextInput<TSession>): Promise<AgentLoopPrepareChatSessionContextResult<TSession>>;
  ensureChatLoopSessionContext?<TSession, TMode>(input: AgentLoopEnsureChatSessionContextInput<TSession, TMode>): Promise<TSession>;
  getLLMConfig?: () => ChatLLMRuntimeConfig;
  isLLMRunCancelled?(): boolean;
  onLLMLog?(event: { kind: "call_start" | "stream_start" | "stream_end" | "response_received" | "rate_limited" | "finish_and_wait_resume_error"; round: number; stream: boolean; model?: string; attempt?: number; error?: string }): void;
  onLLMHeartbeatStarted?(): void;
  onLLMSessionUpdated?(session: LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] }): void;
  onLLMSessionCleared?(reason: LLMSessionClearReason): void;
  onLLMSessionRebuilt?(): void;
  onLLMSessionCompleted?(result: { sentMessage: boolean }): void;
  initialLLMSession?: LLMSessionSnapshot;
  loadLLMSession?(): LLMSessionSnapshot | undefined;
  getAgentInitiatedBehaviorPlans?: () => AgentInitiatedBehaviorPlan[];
  recordAgentInitiatedBehaviorRun?(run: AgentInitiatedBehaviorRun): void;
  random?: () => number;
};

export interface ChatAgent {
  start(): Promise<void>;
  stop(): Promise<void>;
  prepareEventRun(event: AgentEvent, options?: { agentLoopRunSeq?: number }): Promise<PreparedAgentLoopRun | AgentOutput[]>;
  getState(): AgentStateSnapshot | undefined;
  registerChannel(plugin: ChannelPlugin): void;
  clearLLMSession(reason: LLMSessionClearReason): void;
}

export function createChatAgent(deps: ChatAgentDeps): ChatAgent {
  const channels: ChannelPlugin[] = [];
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const random = deps.random ?? Math.random;
  let lastCompletedToolName: string | undefined;
  type LLMSessionRecord = ChatAgentLoopSession & {
    id: number;
    messages: LLMChatInput["messages"];
    staticPromptFingerprint: string;
    staticPromptMessageCount: number;
    requestTimestamps: number[];
    lastTotalTokens?: number;
    lastInputTokens?: number;
    lastUsageModel?: string;
    tokenPressurePreviewBaselines: Record<string, TokenPressurePreviewBaseline>;
    mode: string;
    modeStaticMessages: LLMChatInput["messages"];
    modeStaticTokenEstimate: number;
    modeStartedAt?: number;
    modeExpiresAt?: number;
    fixedPrefixKind?: string;
    fixedPrefixCursorMessageId?: number;
    waitChatStartedAt?: number;
    lastCheckChatCursorMessageId?: number;
  };
  const setActiveLoopSessionContext = deps.setActiveLoopSessionContext ?? ((input: AgentLoopSetActiveSessionContextInput<LLMSessionRecord>) => {
    setAgentLoopActiveSessionContext(input);
  });
  const clearActiveLoopSessionContext = deps.clearActiveLoopSessionContext ?? ((input: AgentLoopClearActiveSessionContextInput<LLMSessionRecord>) => {
    return clearAgentLoopActiveSessionContext(input);
  });
  const createActiveLoopSessionContext = deps.createActiveLoopSessionContext ?? ((input: AgentLoopCreateActiveSessionContextInput<LLMSessionRecord>) => {
    return createAgentLoopActiveSessionContext(input);
  });
  const prepareChatLoopSessionContext = deps.prepareChatLoopSessionContext ?? ((input: AgentLoopPrepareChatSessionContextInput<LLMSessionRecord>) => {
    return prepareAgentLoopChatSessionContext({
      ...input,
      updateSession(session) {
        input.updateSession?.(session);
      }
    });
  });
  const ensureChatLoopSessionContext = deps.ensureChatLoopSessionContext ?? ensureAgentLoopChatSessionContext;
  let applyModeStateToNewSession: ModeState | undefined;

  return {
    async start() {
      deps.state?.start();
      await Promise.all(channels.map((channel) => channel.start()));
    },
    async stop() {
      await Promise.all([...channels].reverse().map((channel) => channel.stop()));
      deps.state?.stop();
    },
    getState() {
      return deps.state?.getSnapshot();
    },
    registerChannel(plugin) {
      channels.push(plugin);
      deps.outputRouter.register(plugin);
    },
    clearLLMSession(reason) {
      deps.onLLMSessionCleared?.(reason);
    },
    async prepareEventRun(event, options = {}) {
      const decision = await deps.policy.check(event);
      if (!decision.allowed) {
        return [
          buildReply(event, time, {
            kind: "text",
            text: decision.reason ? `Request denied: ${decision.reason}` : "Request denied."
          })
        ];
      }

      const sessionId = await deps.sessionResolver.resolve(event);
      const routed = deps.intentRouter.route({
        ...event,
        externalSession: { ...event.externalSession, sessionId }
      });

      if (routed.kind === "unsupported") {
        return [buildReply(event, time, { kind: "text", text: routed.reason })];
      }

      if (routed.kind === "codex") {
        return [
          buildReply(event, time, {
            kind: "markdown",
            markdown: `Codex command accepted by router, but Codex worker is not implemented yet.\n\nPrompt: ${routed.prompt || "(empty)"}`
          })
        ];
      }

      const promptProfile = requirePromptProfile();
      const allToolPlugins = deps.tools ?? [];
      const toolPlugins = filterVisibleTools(allToolPlugins, promptProfile);
      let loopSession = deps.initialLLMSession?.staticPromptFingerprint
        ? hydrateLLMSessionSnapshot(deps.initialLLMSession)
        : undefined;
      const setLoopSession = (session: LLMSessionRecord | undefined): void => {
        setActiveLoopSessionContext({
          kind: "chat",
          session,
          setLocalSession(nextSession) {
            loopSession = nextSession;
          }
        });
      };
      const clearLoopSession = (onCleared?: () => void): boolean => clearActiveLoopSessionContext({
        kind: "chat",
        getLocalSession: () => loopSession,
        setLocalSession(nextSession) {
          loopSession = nextSession;
        },
        onCleared
      });
      let initiatedBehavior = agentInitiatedBehaviorPlanFromEvent(
        event,
        deps.getAgentInitiatedBehaviorPlans?.() ?? defaultAgentInitiatedBehaviorPlans,
        random
      );
      if (deps.loadLLMSession) {
        const persistedSession = deps.loadLLMSession();
        setLoopSession(persistedSession?.staticPromptFingerprint
          ? hydrateLLMSessionSnapshot(persistedSession)
          : undefined);
      }
      const buildPromptContext = () => makePromptContext({
        event,
        time,
        getDailyShell: deps.getDailyShell,
        getDailyShellRaw: deps.getDailyShellRaw,
        getAppearanceDescription: deps.getAppearanceDescription,
        getLibrarySetting: deps.getLibrarySetting,
        getMemorySnapshot: deps.getMemorySnapshot,
        getWakeBoundary: deps.getWakeBoundary,
        getCalendarContext: deps.getCalendarContext,
        getAvailableSkills: deps.getAvailableSkills
      });
      const initiatedBehaviorRunPlan = initiatedBehavior;
      let initiatedBehaviorExecution: Awaited<ReturnType<typeof executeAgentInitiatedBehaviorBackendSteps>> | undefined;
      const initiatedBehaviorLlmSteps = (
        result: "completed" | "skipped" | "failed",
        error?: string
      ): AgentInitiatedBehaviorRun["steps"] => (initiatedBehaviorRunPlan?.steps ?? [])
        .filter((step) => step.kind === "llm_instruction")
        .map((step) => ({ kind: step.kind, result, error }));
      const recordInitiatedBehaviorRun = (input: {
        result: AgentInitiatedBehaviorRun["result"];
        steps: AgentInitiatedBehaviorRun["steps"];
        error?: string;
      }) => {
        if (!initiatedBehaviorRunPlan) return;
        const triggeredTime = time.now();
        deps.recordAgentInitiatedBehaviorRun?.(createAgentInitiatedBehaviorRun({
          plan: initiatedBehaviorRunPlan,
          triggeredAt: triggeredTime.iso,
          triggeredAtUtc: triggeredTime.date.toISOString(),
          trigger: initiatedBehaviorRunPlan.triggerEvent ?? agentInitiatedTriggerEventFromRaw(event.meta.raw) ?? initiatedBehaviorRunPlan.id,
          result: input.result,
          sessionId,
          steps: input.steps,
          error: input.error
        }));
      };
      if (initiatedBehavior) {
        const availability = resolveAgentInitiatedBehaviorAvailability(initiatedBehavior, promptProfile, allToolPlugins);
        if (availability.status === "unavailable") {
          recordInitiatedBehaviorRun({
            result: "skipped",
            steps: availability.steps.map((step) => ({
              kind: step.kind,
              result: step.status === "available" ? "skipped" : "failed",
              error: step.reason
            })),
            error: availability.reason
          });
          initiatedBehavior = undefined;
        }
      }
      if (initiatedBehavior) {
        initiatedBehaviorExecution = await executeAgentInitiatedBehaviorBackendSteps(initiatedBehavior, event, sessionId, allToolPlugins);
        if (initiatedBehaviorExecution.result === "failed" || initiatedBehaviorExecution.result === "dry_run" || initiatedBehaviorExecution.result === "skipped") {
          recordInitiatedBehaviorRun({
            result: initiatedBehaviorExecution.result,
            steps: initiatedBehaviorExecution.steps,
            error: initiatedBehaviorExecution.error
          });
          initiatedBehavior = undefined;
        }
      }
      if (initiatedBehaviorRunPlan && !initiatedBehavior && (!initiatedBehaviorExecution || initiatedBehaviorExecution.result !== "completed")) {
        return [];
      }
      let createdSessionThisRun = false;
      let initiatedBehaviorMessageCount = 0;
      const alignSessionStaticPromptFingerprint = (session: { staticPromptFingerprint: string }): void => {
        session.staticPromptFingerprint = staticPromptFingerprint(promptProfile, buildPromptContext());
      };
      const ensureLoopSession = async (): Promise<LLMSessionRecord> => {
        const promptContext = buildPromptContext();
        const fingerprint = staticPromptFingerprint(promptProfile, promptContext);
        let initiatedBehaviorPromptToolResult: ToolResult | undefined;
        const session = await ensureChatLoopSessionContext<LLMSessionRecord, ModeState>({
          getSession: () => loopSession,
          getPendingMode: () => applyModeStateToNewSession,
          setPendingMode(mode) {
            applyModeStateToNewSession = mode;
          },
          defaultMode: defaultModeState,
          shouldClearForInitiatedBehavior: () => Boolean(initiatedBehavior),
          isModeExpired,
          isStaticPromptChanged: (session) => session.mode !== "fixed_prefix" && session.staticPromptFingerprint !== fingerprint,
          shouldResetForTokenPressure: (session) => shouldResetSessionForTokenPressure(session, event, findToolPlugin(toolPlugins, "check_chat")),
          modeFromSession: modeStateFromSession,
          clearSession(reason) {
            return clearLoopSession(reason ? () => deps.onLLMSessionCleared?.(reason as LLMSessionClearReason) : undefined);
          },
          async prepareSession(mode) {
            let promptCheckChatCursor: number | undefined;
            const preparedSession = await prepareChatLoopSessionContext({
              buildMessages: async () => {
                if (mode.mode === "fixed_prefix") return cloneLLMMessages(mode.modeStaticMessages);
                const initiatedMessages = await buildAgentInitiatedBehaviorMessages(initiatedBehavior, promptProfile, promptContext, async (layer, call) => {
                  const result = await runPromptToolRequest(layer, call, toolPlugins);
                  promptCheckChatCursor = checkChatCursorFromResult(call.toolName, result) ?? promptCheckChatCursor;
                  initiatedBehaviorPromptToolResult = result;
                  return result;
                });
                initiatedBehaviorMessageCount = initiatedMessages.length;
                return [
                  ...await buildPromptMessagesWithToolResults(promptProfile, promptContext, async (layer, call) => {
                    const result = await runPromptToolRequest(layer, call, toolPlugins);
                    promptCheckChatCursor = checkChatCursorFromResult(call.toolName, result) ?? promptCheckChatCursor;
                    return result;
                  }),
                  ...initiatedMessages,
                  ...mode.modeStaticMessages
                ];
              },
              createSession(promptMessages): LLMSessionRecord {
                return {
                  id: time.now().epochMs,
                  messages: promptMessages,
                  staticPromptFingerprint: fingerprint,
                  staticPromptMessageCount: promptMessages.length,
                  requestTimestamps: [],
                  tokenPressurePreviewBaselines: cloneTokenPressurePreviewBaselines(mode.tokenPressurePreviewBaselines),
                  mode: mode.mode,
                  modeStaticMessages: cloneLLMMessages(mode.modeStaticMessages),
                  modeStaticTokenEstimate: mode.modeStaticTokenEstimate,
                  modeStartedAt: mode.modeStartedAt,
                  modeExpiresAt: mode.modeExpiresAt,
                  fixedPrefixKind: mode.fixedPrefixKind,
                  fixedPrefixCursorMessageId: mode.fixedPrefixCursorMessageId,
                  waitChatStartedAt: undefined,
                  lastCheckChatCursorMessageId: mode.fixedPrefixCursorMessageId ?? promptCheckChatCursor
                };
              },
              setLocalSession(session) {
                loopSession = session;
              }
            });
            initiatedBehavior = undefined;
            createdSessionThisRun = true;
            return preparedSession.session;
          }
        });
        if (initiatedBehaviorPromptToolResult) {
          applyBackendToolSessionControlToActiveSession(session, initiatedBehaviorPromptToolResult, time.now().epochMs, alignSessionStaticPromptFingerprint);
          noteLLMSessionUpdated(session);
        }
        if (!loopSession) throw new Error("llm_session_unavailable");
        return loopSession;
      };
      let sentMessage = false;
      let sessionRunStarted = false;
      let llmInput: ChatAgentLoopInput["llmInput"] | undefined;
      let preparedLoop: ReturnType<typeof buildChatAgentLoop> | undefined;
      const appendLoopSessionContext = deps.appendLoopSessionContext ?? appendAgentLoopSessionContext;
      const appendSessionContext = async (session: LLMSessionRecord): Promise<void> => {
        const waitChatResumeMessages = await buildWaitChatResumeMessages({
          session,
          event,
          toolPlugins,
          time,
          buildTextVariables: buildTurnTextVariables,
          onLLMLog: deps.onLLMLog
        });
        if (waitChatResumeMessages.length > 0) {
          session.waitChatStartedAt = undefined;
          appendLoopSessionContext({
            session,
            messages: waitChatResumeMessages,
            updateSession: noteLLMSessionUpdated
          });
          return;
        }
        const promptContext = buildPromptContext();
        if (session.mode === "fixed_prefix") {
          const appendMessages = await buildFixedPrefixAppendMessages({
            mode: modeStateFromSession(session),
            event,
            toolPlugins,
            nextToolCallId: () => "append_fixed_prefix_check_chat",
            buildTextVariables: buildTurnTextVariables,
            onCheckChatResult(result) {
              const cursor = checkChatCursorFromResult("check_chat", result);
              session.lastCheckChatCursorMessageId = cursor ?? session.lastCheckChatCursorMessageId;
              session.fixedPrefixCursorMessageId = cursor ?? session.fixedPrefixCursorMessageId;
            }
          });
          if (appendMessages.length === 0) return;
          appendLoopSessionContext({
            session,
            messages: appendMessages,
            updateSession: noteLLMSessionUpdated
          });
          return;
        }
        if (createdSessionThisRun) return;
        const appendProfile = {
          ...promptProfile,
          appendLayers: (promptProfile.appendLayers ?? []).filter((layer) => (
            layer.role !== "tool_request" || (layer.toolCalls ?? []).every((call) => Boolean(findToolPlugin(toolPlugins, call.toolName)))
          )).map((layer) => {
            if (layer.role !== "tool_request") return layer;
            return {
              ...layer,
              toolCalls: (layer.toolCalls ?? []).map((call, index) => ({
                ...call,
                toolCallId: call.toolCallId ?? `append_${layer.id}_${index + 1}`
              }))
            };
          })
        };
        const appendMessages = await buildAppendPromptMessagesWithToolResults(appendProfile, promptContext, (layer, call) => {
          return runPromptToolRequest(layer, call, toolPlugins).then((result) => {
            session.lastCheckChatCursorMessageId = checkChatCursorFromResult(call.toolName, result) ?? session.lastCheckChatCursorMessageId;
            return result;
          });
        });
        if (appendMessages.length === 0) return;
        appendLoopSessionContext({
          session,
          messages: appendMessages,
          updateSession: noteLLMSessionUpdated
        });
      };
      return {
        async prepare() {
          await ensureLoopSession();
          if (initiatedBehaviorRunPlan && initiatedBehaviorExecution?.result === "completed" && initiatedBehaviorRunPlan.steps.some((step) => step.kind === "llm_instruction") && initiatedBehaviorMessageCount === 0) {
            recordInitiatedBehaviorRun({
              result: "skipped",
              steps: [
                ...initiatedBehaviorExecution.steps,
                ...initiatedBehaviorLlmSteps("skipped", "llm_messages_empty")
              ],
              error: "llm_messages_empty"
            });
            return [];
          }
          if (!loopSession || loopSession.messages.length === 0) {
            if (initiatedBehaviorRunPlan && initiatedBehaviorExecution?.result === "completed") {
              recordInitiatedBehaviorRun({
                result: "skipped",
                steps: [
                  ...initiatedBehaviorExecution.steps,
                  ...initiatedBehaviorLlmSteps("skipped", "llm_messages_empty")
                ],
                error: "llm_messages_empty"
              });
            }
            return [];
          }
          deps.onLLMHeartbeatStarted?.();
          sessionRunStarted = true;
          loopSession.agentLoopRunSeq = options.agentLoopRunSeq ?? loopSession.agentLoopRunSeq ?? 1;
          noteLLMSessionUpdated(loopSession);
          await appendSessionContext(loopSession);
          const llmConfig = deps.getLLMConfig?.() ?? {
            client: deps.llm,
            model: deps.config.llm.model,
            temperature: deps.config.llm.temperature,
            extraParams: deps.config.llm.extraParams,
            followupExtraParams: deps.config.llm.followupExtraParams,
            presetName: undefined,
            stream: deps.config.llm.stream,
            supportsImage: false,
            supportsAudio: false
          };
          llmInput = {
            messages: loopSession.messages,
            client: llmConfig.client,
            model: llmConfig.model,
            temperature: llmConfig.temperature,
            extraParams: llmConfig.extraParams,
            followupExtraParams: llmConfig.followupExtraParams,
            presetName: llmConfig.presetName,
            stream: llmConfig.stream,
            supportsImage: llmConfig.supportsImage,
            supportsAudio: llmConfig.supportsAudio,
            toolNames: toolPlugins.flatMap((plugin) => plugin.listTools().map((tool) => tool.name))
          };
          preparedLoop = buildChatAgentLoop({
            llmInput,
            event,
            toolPlugins,
            session: loopSession,
            ensureSession: ensureLoopSession,
            appendSessionContext,
            llm: deps.llm,
            llmRequestSender: deps.llmRequestSender,
            time,
            buildTextVariables: buildTurnTextVariables,
            noteSessionUpdated: () => {
              if (loopSession) noteLLMSessionUpdated(loopSession);
            },
            getLastCompletedToolName: () => lastCompletedToolName,
            setLastCompletedToolName(name) {
              lastCompletedToolName = name;
            },
            applyModeStateToNewSession(mode) {
              applyModeStateToNewSession = mode;
              clearLoopSession();
            },
            onFixedPrefixCleared(session) {
              alignSessionStaticPromptFingerprint(session as LLMSessionRecord);
            },
            onSessionRebuilt: deps.onLLMSessionRebuilt,
            isLLMRunCancelled: deps.isLLMRunCancelled,
            agentLoopRunSeq: loopSession.agentLoopRunSeq,
            onLLMRequestPrepared: deps.onLLMRequestPrepared,
            onLLMResponseReceived: deps.onLLMResponseReceived,
            agentRunIndicator: deps.agentRunIndicator,
            onAgentRunIndicatorError: deps.onAgentRunIndicatorError,
            onLLMLog: deps.onLLMLog
          });
          return preparedLoop.spec;
        },
        onError(error) {
          if (initiatedBehaviorRunPlan && initiatedBehaviorExecution?.result === "completed") {
            const message = error instanceof Error ? error.message : String(error);
            recordInitiatedBehaviorRun({
              result: "failed",
              steps: [
                ...initiatedBehaviorExecution.steps,
                ...initiatedBehaviorLlmSteps("failed", message)
              ],
              error: message
            });
          }
        },
        dispose() {
          if (sessionRunStarted) deps.onLLMSessionCompleted?.({ sentMessage });
        },
        complete(loopResult) {
          if (!preparedLoop) return [];
          const llmResult = preparedLoop.complete(loopResult);
          sentMessage = llmResult.sentMessage;
          if (initiatedBehaviorRunPlan && initiatedBehaviorExecution?.result === "completed") {
            if (llmResult.cancelled) {
              recordInitiatedBehaviorRun({
                result: "skipped",
                steps: [
                  ...initiatedBehaviorExecution.steps,
                  ...initiatedBehaviorLlmSteps("skipped", "llm_cancelled")
                ],
                error: "llm_cancelled"
              });
            } else if (!llmResult.finalResult) {
              recordInitiatedBehaviorRun({
                result: "failed",
                steps: [
                  ...initiatedBehaviorExecution.steps,
                  ...initiatedBehaviorLlmSteps("failed", "llm_result_missing")
                ],
                error: "llm_result_missing"
              });
            } else {
              if (loopSession && initiatedBehaviorExecution.toolResult) {
                applyBackendToolSessionControlToActiveSession(loopSession, initiatedBehaviorExecution.toolResult, time.now().epochMs, alignSessionStaticPromptFingerprint);
                noteLLMSessionUpdated(loopSession);
              }
              recordInitiatedBehaviorRun({
                result: "completed",
                steps: [
                  ...initiatedBehaviorExecution.steps,
                  ...initiatedBehaviorLlmSteps("completed")
                ]
              });
            }
          }
          if (llmResult.cancelled) {
            clearLoopSession(() => deps.onLLMSessionCleared?.("admin_cancel"));
            return [];
          }
          if (llmResult.invalidateSession) {
            clearLoopSession(() => deps.onLLMSessionCleared?.("prompt_static_changed"));
          }
          const usage = llmResult.finalResult?.usage;
          const usageModel = llmResult.finalResult?.model ?? llmInput?.model;
          if (loopSession && usage) {
            if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
              loopSession.lastTotalTokens = usage.totalTokens;
            }
            if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
              loopSession.lastInputTokens = usage.inputTokens;
            }
            if (usageModel) loopSession.lastUsageModel = usageModel;
            noteLLMSessionUpdated(loopSession);
          }
          return [];
        }
      };
    }
  };

  function buildTurnTextVariables(event: AgentEvent): LLMTextVariables {
    return buildLLMTextVariables({
      userName: requirePromptProfile().userName,
      time,
      event,
      dailyShell: deps.getDailyShell?.(),
      dailyShellRaw: deps.getDailyShellRaw?.(),
      appearanceDescription: deps.getAppearanceDescription?.(),
      librarySetting: deps.getLibrarySetting?.(),
      memory: deps.getMemorySnapshot?.(),
      wakeBoundary: deps.getWakeBoundary?.(),
      calendarContext: deps.getCalendarContext?.(),
      extra: {
        available_skills: deps.getAvailableSkills?.() ?? ""
      }
    });
  }

  function requirePromptProfile(): PromptProfile {
    const profile = deps.getPromptProfile?.();
    if (!profile) throw new Error("ChatAgent requires getPromptProfile");
    return profile;
  }

  async function shouldResetSessionForTokenPressure(
    session: LLMSessionRecord,
    event: AgentEvent,
    plugin: ToolPlugin | undefined
  ): Promise<boolean> {
    const inputTokens = finiteTokenCount(session.lastInputTokens) ?? finiteTokenCount(session.lastTotalTokens);
    if (inputTokens === undefined || inputTokens <= 0) return false;
    if (!plugin) return false;
    const previewInput = tokenPressurePreviewInput(session);
    const preview = await plugin.execute({
      id: createId("token_pressure_preview"),
      toolName: "check_chat",
      input: previewInput,
      requester: event.source,
      externalSession: event.externalSession
    });
    if (!preview.ok) return false;
    const currentPreviewTokens = estimateTextTokens(toolResultText(preview));
    const baselineKey = tokenPressureBaselineKey(session, previewInput.__scope);
    const baseline = session.tokenPressurePreviewBaselines[baselineKey];
    if (!isTokenPressurePreviewBaseline(baseline)) {
      session.tokenPressurePreviewBaselines[baselineKey] = {
        inputTokens,
        previewTokens: currentPreviewTokens
      };
      noteLLMSessionUpdated(session);
      return false;
    }
    const price = deepSeekPriceForModel(session.lastUsageModel ?? deps.config.llm.model);
    const comparison = calculateTokenPressureSwitch({
      lastInputTokens: inputTokens,
      baselineInputTokens: baseline.inputTokens,
      baselinePreviewTokens: baseline.previewTokens,
      currentPreviewTokens,
      cacheHitPrice: price.hit,
      cacheMissPrice: price.miss,
      contextImportance: deps.config.llm.tokenPressureContextImportance
    });
    if (comparison.shouldReset) {
      session.tokenPressurePreviewBaselines[baselineKey] = {
        inputTokens: comparison.estimatedCurrentInputTokens,
        previewTokens: currentPreviewTokens
      };
      noteLLMSessionUpdated(session);
    }
    return comparison.shouldReset;
  }

  function tokenPressurePreviewInput(session: LLMSessionRecord): { __preview: true; __scope: "today" | "from_prefix"; __fromPrefixAfterMessageId?: number } {
    if (session.mode === "fixed_prefix") {
      return {
        __preview: true,
        __scope: "from_prefix",
        __fromPrefixAfterMessageId: session.fixedPrefixCursorMessageId ?? 0
      };
    }
    return { __preview: true, __scope: "today" };
  }

  function tokenPressureBaselineKey(session: LLMSessionRecord, scope: "today" | "from_prefix"): string {
    return [
      session.lastUsageModel ?? deps.config.llm.model ?? "",
      session.mode || "normal",
      scope,
      scope === "from_prefix" ? String(session.fixedPrefixCursorMessageId ?? 0) : ""
    ].join("|");
  }

  function hydrateLLMSessionSnapshot(snapshot: LLMSessionSnapshot): LLMSessionRecord {
    const modeStaticMessages = cloneLLMMessages(snapshot.modeStaticMessages ?? []);
    const mode = snapshot.mode || "normal";
    const parsedModeStartedAt = typeof snapshot.modeStartedAt === "string" ? Date.parse(snapshot.modeStartedAt) : NaN;
    const parsedModeExpiresAt = typeof snapshot.modeExpiresAt === "string" ? Date.parse(snapshot.modeExpiresAt) : NaN;
    return {
      id: Number.isFinite(snapshot.id) ? Number(snapshot.id) : time.now().epochMs,
      messages: cloneLLMMessages(snapshot.messages),
      staticPromptFingerprint: snapshot.staticPromptFingerprint ?? "",
      staticPromptMessageCount: typeof snapshot.staticPromptMessageCount === "number" && Number.isFinite(snapshot.staticPromptMessageCount)
        ? Math.max(0, Math.floor(snapshot.staticPromptMessageCount))
        : 0,
      requestTimestamps: (snapshot.requestTimestamps ?? [])
        .map((timestamp) => Date.parse(timestamp))
        .filter((timestamp) => Number.isFinite(timestamp)),
      agentLoopRunSeq: Number.isInteger(snapshot.agentLoopRunSeq) ? snapshot.agentLoopRunSeq : undefined,
      lastTotalTokens: Number.isFinite(snapshot.lastTotalTokens) ? snapshot.lastTotalTokens : undefined,
      lastInputTokens: Number.isFinite(snapshot.lastInputTokens) ? snapshot.lastInputTokens : undefined,
      lastUsageModel: typeof snapshot.lastUsageModel === "string" ? snapshot.lastUsageModel : undefined,
      tokenPressurePreviewBaselines: cloneTokenPressurePreviewBaselines(snapshot.tokenPressurePreviewBaselines),
      mode,
      modeStaticMessages,
      modeStaticTokenEstimate: Number.isFinite(snapshot.modeStaticTokenEstimate)
        ? Number(snapshot.modeStaticTokenEstimate)
        : estimateMessagesTokens(modeStaticMessages),
      modeStartedAt: mode === "normal"
        ? undefined
        : Number.isFinite(parsedModeStartedAt)
          ? parsedModeStartedAt
          : time.now().epochMs,
      modeExpiresAt: Number.isFinite(parsedModeExpiresAt) ? parsedModeExpiresAt : undefined,
      fixedPrefixKind: typeof snapshot.fixedPrefixKind === "string" ? snapshot.fixedPrefixKind : undefined,
      fixedPrefixCursorMessageId: typeof snapshot.fixedPrefixCursorMessageId === "number" && Number.isFinite(snapshot.fixedPrefixCursorMessageId)
        ? snapshot.fixedPrefixCursorMessageId
        : undefined,
      waitChatStartedAt: typeof snapshot.waitChatStartedAt === "string" && Number.isFinite(Date.parse(snapshot.waitChatStartedAt))
        ? Date.parse(snapshot.waitChatStartedAt)
        : undefined,
      lastCheckChatCursorMessageId: typeof snapshot.fixedPrefixCursorMessageId === "number" && Number.isFinite(snapshot.fixedPrefixCursorMessageId)
        ? snapshot.fixedPrefixCursorMessageId
        : undefined
    };
  }

  function defaultModeState(): ModeState {
    return defaultChatAgentModeState();
  }

  function modeStateFromSession(session: LLMSessionRecord): ModeState {
    return {
      mode: session.mode || "normal",
      modeStaticMessages: cloneLLMMessages(session.modeStaticMessages),
      modeStaticTokenEstimate: session.modeStaticTokenEstimate,
      tokenPressurePreviewBaselines: cloneTokenPressurePreviewBaselines(session.tokenPressurePreviewBaselines),
      modeStartedAt: session.modeStartedAt,
      modeExpiresAt: session.modeExpiresAt,
      fixedPrefixKind: session.fixedPrefixKind,
      fixedPrefixCursorMessageId: session.fixedPrefixCursorMessageId
    };
  }

  function isModeExpired(session: LLMSessionRecord): boolean {
    if (session.mode !== "fixed_prefix") return false;
    if (!Number.isFinite(session.modeExpiresAt)) return false;
    return time.now().epochMs >= Number(session.modeExpiresAt);
  }

  function cloneTokenPressurePreviewBaselines(value: Record<string, TokenPressurePreviewBaseline> | undefined): Record<string, TokenPressurePreviewBaseline> {
    const result: Record<string, TokenPressurePreviewBaseline> = {};
    for (const [key, entry] of Object.entries(value ?? {})) {
      if (isTokenPressurePreviewBaseline(entry)) {
        result[key] = { inputTokens: entry.inputTokens, previewTokens: entry.previewTokens };
      }
    }
    return result;
  }

  function noteLLMSessionUpdated(session: LLMSessionRecord): void {
    deps.onLLMSessionUpdated?.({
      id: session.id,
      messages: cloneLLMMessages(session.messages),
      staticPromptFingerprint: session.staticPromptFingerprint,
      staticPromptMessageCount: session.staticPromptMessageCount,
      requestTimestamps: session.requestTimestamps.map((timestamp) => new Date(timestamp).toISOString()),
      agentLoopRunSeq: session.agentLoopRunSeq,
      lastTotalTokens: session.lastTotalTokens,
      lastInputTokens: session.lastInputTokens,
      lastUsageModel: session.lastUsageModel,
      tokenPressurePreviewBaselines: cloneTokenPressurePreviewBaselines(session.tokenPressurePreviewBaselines),
      mode: session.mode,
      modeStaticMessages: cloneLLMMessages(session.modeStaticMessages),
      modeStaticTokenEstimate: session.modeStaticTokenEstimate,
      modeStartedAt: typeof session.modeStartedAt === "number" ? new Date(session.modeStartedAt).toISOString() : undefined,
      modeExpiresAt: typeof session.modeExpiresAt === "number" ? new Date(session.modeExpiresAt).toISOString() : undefined,
      fixedPrefixKind: session.fixedPrefixKind,
      fixedPrefixCursorMessageId: session.fixedPrefixCursorMessageId,
      waitChatStartedAt: typeof session.waitChatStartedAt === "number" ? new Date(session.waitChatStartedAt).toISOString() : undefined
    });
  }
}

async function executeAgentInitiatedBehaviorBackendSteps(
  plan: AgentInitiatedBehaviorPlan,
  event: AgentEvent,
  sessionId: string,
  toolPlugins: ToolPlugin[]
): Promise<{
  result: AgentInitiatedBehaviorRun["result"];
  steps: AgentInitiatedBehaviorRun["steps"];
  error?: string;
  toolResult?: ToolResult;
}> {
  const steps: AgentInitiatedBehaviorRun["steps"] = [];
  let latestToolResult: ToolResult | undefined;
  if (!plan.enabled) {
    return { result: "skipped", steps: [{ kind: "record_only", result: "skipped", error: "behavior_disabled" }], error: "behavior_disabled" };
  }
  if (plan.dryRun) {
    return {
      result: "dry_run",
      steps: plan.steps.map((step) => ({ kind: step.kind, result: "skipped" }))
    };
  }
  for (const step of plan.steps) {
    if (step.kind === "llm_instruction") continue;
    if (step.kind === "record_only") {
      steps.push({ kind: step.kind, result: "completed" });
      continue;
    }
    if (step.effect !== "sleep_cocoon") {
      const error = `unsupported_backend_effect:${step.effect}`;
      steps.push({ kind: step.kind, result: "failed", error });
      return { result: "failed", steps, error };
    }
    const plugin = findToolPlugin(toolPlugins, "sleep_cocoon");
    if (!plugin) {
      const error = "sleep_cocoon_tool_unavailable";
      steps.push({ kind: step.kind, result: "failed", error });
      return { result: "failed", steps, error };
    }
    try {
      const result = await plugin.execute({
        id: createId(`initiated_${plan.id}`),
        toolName: "sleep_cocoon",
        input: step.arguments,
        requester: event.source,
        externalSession: { ...event.externalSession, sessionId }
      });
      if (!result.ok) {
        const error = result.error ?? "sleep_cocoon_backend_effect_failed";
        steps.push({ kind: step.kind, result: "failed", error });
        return { result: "failed", steps, error };
      }
      latestToolResult = result;
      steps.push({ kind: step.kind, result: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ kind: step.kind, result: "failed", error: message });
      return { result: "failed", steps, error: message };
    }
  }
  return { result: "completed", steps, toolResult: latestToolResult };
}

function applyBackendToolSessionControlToActiveSession(
  session: {
    messages: LLMChatInput["messages"];
    staticPromptFingerprint: string;
    mode: string;
    modeStaticMessages: LLMChatInput["messages"];
    modeStaticTokenEstimate: number;
    tokenPressurePreviewBaselines: Record<string, TokenPressurePreviewBaseline>;
    modeStartedAt?: number;
    modeExpiresAt?: number;
    fixedPrefixKind?: string;
    fixedPrefixCursorMessageId?: number;
    lastCheckChatCursorMessageId?: number;
  },
  toolResult: ToolResult,
  nowMs: number,
  alignStaticPromptFingerprint: (session: { staticPromptFingerprint: string }) => void
): void {
  if (!toolResult.resetLLMSession) return;
  if (toolResult.clearFixedPrefix) {
    const mode = defaultChatAgentModeState();
    session.mode = mode.mode;
    session.modeStaticMessages = cloneLLMMessages(mode.modeStaticMessages);
    session.modeStaticTokenEstimate = mode.modeStaticTokenEstimate;
    session.tokenPressurePreviewBaselines = {};
    session.modeStartedAt = undefined;
    session.modeExpiresAt = undefined;
    session.fixedPrefixKind = undefined;
    session.fixedPrefixCursorMessageId = undefined;
    alignStaticPromptFingerprint(session);
    return;
  }
  const fixedPrefixKind = typeof toolResult.fixedPrefixKind === "string" && toolResult.fixedPrefixKind
    ? toolResult.fixedPrefixKind
    : undefined;
  const mode = fixedPrefixKind ? "fixed_prefix" : toolResult.llmSessionMode || "normal";
  const modeStaticMessages = mode === "fixed_prefix"
    ? cloneLLMMessages(session.messages)
    : mode === "normal"
      ? []
      : cloneLLMMessages((toolResult.llmSessionStaticMessages as LLMChatInput["messages"] | undefined) ?? session.messages);
  const modeStartedAt = mode === "normal" ? undefined : nowMs;
  const ttlMs = Number.isFinite(toolResult.fixedPrefixTtlMs) ? Number(toolResult.fixedPrefixTtlMs) : 2 * 60 * 60 * 1000;
  session.mode = mode;
  session.modeStaticMessages = modeStaticMessages;
  session.modeStaticTokenEstimate = estimateMessagesTokens(modeStaticMessages);
  session.tokenPressurePreviewBaselines = {};
  session.modeStartedAt = modeStartedAt;
  session.modeExpiresAt = mode === "fixed_prefix" && typeof modeStartedAt === "number" ? modeStartedAt + ttlMs : undefined;
  session.fixedPrefixKind = fixedPrefixKind;
  session.fixedPrefixCursorMessageId = mode === "fixed_prefix" ? session.lastCheckChatCursorMessageId : undefined;
}

function filterVisibleTools(tools: ToolPlugin[], profile: PromptProfile): ToolPlugin[] {
  return tools.filter((plugin) => {
    if (plugin.id === "messaging") return isToolVisibleInPromptProfile(profile, "messaging");
    if (plugin.id === "photo") return isToolVisibleInPromptProfile(profile, "photo");
    if (plugin.id === "shell") return isToolVisibleInPromptProfile(profile, "shell");
    return plugin.listTools().some((tool) => isToolVisibleInPromptProfile(profile, tool.name));
  });
}

function finiteTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTokenPressurePreviewBaseline(value: unknown): value is TokenPressurePreviewBaseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<TokenPressurePreviewBaseline>;
  return typeof entry.inputTokens === "number"
    && Number.isFinite(entry.inputTokens)
    && typeof entry.previewTokens === "number"
    && Number.isFinite(entry.previewTokens);
}

function buildReply(
  event: AgentEvent,
  time: CurrentTimeProvider,
  content: AgentOutput["content"]
): AgentOutput {
  const now = time.now();
  return {
    id: createId("out"),
    target: {
      plugin: event.source.plugin,
      accountId: event.source.accountId,
      channelId: event.source.channelId,
      userId: event.source.userId,
      sessionId: event.externalSession.sessionId,
      replyTo: event.meta.replyTo ?? event.source.rawMessageId
    },
    content,
    meta: {
      createdAt: now.iso,
      createdAtUtc: now.date.toISOString(),
      urgency: "normal",
      allowStreaming: false
    }
  };
}
