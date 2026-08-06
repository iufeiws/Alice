import type { LLMChatInput, LLMChatResult, LLMClient } from "../../../llm-gateway/src/index.js";
import type { LLMRequestLogEntry } from "../../../llm-session/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { PolicyEngine } from "../ports/policy.js";
import type { IntentRouter } from "./intent-router.js";
import type { SessionResolver } from "./session-resolver.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { AgentEvent, AgentOutput, ChannelPlugin, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";
import { buildAppendPromptMessagesWithToolResults, buildPromptMessagesWithToolResults, makePromptContext, staticPromptFingerprint, type PromptProfile } from "../../../agent-profile/src/application/build-system-prompt.js";
import type { AgentStateController, AgentStateSnapshot } from "../domain/agent-loop-state.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import type { LLMRequestSender } from "../../../llm-gateway/src/llm-tool-loop.js";
import type { AgentRunIndicator } from "../../../agent-run-indicator/src/index.js";
import {
  agentInitiatedBehaviorPlanFromEvent,
  agentInitiatedTriggerEventFromRaw,
  buildAgentInitiatedBehaviorMessages,
  createAgentInitiatedBehaviorRun,
  defaultAgentInitiatedBehaviorPlans,
  resolveAgentInitiatedBehaviorAvailability,
  type AgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorRun
} from "../../../initiative/src/domain/initiated-behavior.js";
import {
  buildWaitChatResumeMessages,
  cloneLLMMessages,
  fixedPrefixToolInput,
  findToolPlugin,
  hasPendingWaitChatToolCall,
  buildChatAgentLoop,
  runPromptToolRequest,
  type ChatAgentLoopInput,
  type ChatAgentModeState
} from "./run-chat-loop.js";
import {
  appendAgentLoopSessionContext,
  clearAgentLoopActiveSessionContext,
  ensureAgentLoopChatSessionContext,
  prepareAgentLoopChatSessionContext,
  setAgentLoopActiveSessionContext,
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
import {
  applyBackendToolSessionControlToActiveSession,
  buildReply,
  executeAgentInitiatedBehaviorBackendSteps,
  failMissingLoopStartedAt,
  filterVisibleTools
} from "./chat-agent-helpers.js";
import {
  cloneTokenPressurePreviewBaselines,
  createLLMSessionSnapshot,
  defaultModeState,
  hydrateLLMSessionSnapshot,
  isModeExpired,
  modeStateFromSession
} from "./chat-agent-session.js";
import { shouldResetSessionForTokenPressure } from "./chat-agent-tools.js";
import type { LLMSessionClearReason, LLMSessionRecord, LLMSessionSnapshot } from "./chat-agent-types.js";
import type { ProcessRestartContinuationRecord, ProcessRestartContinuationStore } from "../adapters/json-process-restart-continuation-store.js";
import { restartSuccessOutput, restartToolName } from "../../../../capabilities/tools/restart/profile.js";

type ModeState = ChatAgentModeState;

export type { LLMSessionClearReason, LLMSessionSnapshot } from "./chat-agent-types.js";
export {
  calculateTokenPressureSwitch,
  type TokenPressureComparison,
  type TokenPressureComparisonInput,
  type TokenPressurePreviewBaseline
} from "./chat-agent-token-pressure.js";
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
    tokenPressureSessionResetEnabled: boolean;
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
  maxTokens?: number;
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
  getPromptRenderer: () => PromptContextRuntime;
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
  onLLMSessionCompleted?(): void;
  createLLMSessionId(occurredAt: string): number;
  initialLLMSession?: LLMSessionSnapshot;
  loadLLMSession?(): LLMSessionSnapshot | undefined;
  getAgentInitiatedBehaviorPlans?: () => AgentInitiatedBehaviorPlan[];
  recordAgentInitiatedBehaviorRun?(run: AgentInitiatedBehaviorRun): void;
  random?: () => number;
  processRestartContinuationStore?: ProcessRestartContinuationStore;
};

export interface ChatAgent {
  start(): Promise<void>;
  stop(): Promise<void>;
  prepareEventRun(event: AgentEvent, options?: { agentLoopRunSeq?: number; signal?: AbortSignal }): Promise<PreparedAgentLoopRun | AgentOutput[]>;
  getState(): AgentStateSnapshot | undefined;
  registerChannel(plugin: ChannelPlugin): void;
  clearLLMSession(reason: LLMSessionClearReason): void;
}

export function createChatAgent(deps: ChatAgentDeps): ChatAgent {
  const channels: ChannelPlugin[] = [];
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const random = deps.random ?? Math.random;
  let lastCompletedToolName: string | undefined;
  const setActiveLoopSessionContext = deps.setActiveLoopSessionContext ?? ((input: AgentLoopSetActiveSessionContextInput<LLMSessionRecord>) => {
    setAgentLoopActiveSessionContext(input);
  });
  const clearActiveLoopSessionContext = deps.clearActiveLoopSessionContext ?? ((input: AgentLoopClearActiveSessionContextInput<LLMSessionRecord>) => {
    return clearAgentLoopActiveSessionContext(input);
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
      if (deps.state?.getSnapshot?.().state !== "sleeping") deps.state?.activate?.("chat");
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
      let persistedProcessRestart = deps.processRestartContinuationStore?.read();
      let activeProcessRestartToolCallId = persistedProcessRestart?.toolCallId;
      let loopSession = deps.initialLLMSession?.staticPromptFingerprint
        ? hydrateLLMSessionSnapshot(deps.initialLLMSession, time.now().epochMs)
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
          ? hydrateLLMSessionSnapshot(persistedSession, time.now().epochMs)
          : undefined);
      }
      if (persistedProcessRestart) {
        if (!loopSession || !matchesPersistedProcessRestartTranscript(persistedProcessRestart, loopSession, event)) {
          const interruptedEventRecovery = persistedProcessRestart.event.externalSession.sessionId === event.externalSession.sessionId;
          deps.processRestartContinuationStore?.clear(persistedProcessRestart.toolCallId);
          activeProcessRestartToolCallId = undefined;
          persistedProcessRestart = undefined;
          clearLoopSession(() => deps.onLLMSessionCleared?.("process_restart_recovery_failed"));
          await failRunIndicatorOnRecoveryFailure(deps);
          if (interruptedEventRecovery) {
            // 恢复校验失败：被中断的消息已在处理流程中，直接放弃，不再降级重跑
            return [];
          }
        }
      }
      const buildPromptContext = () => makePromptContext({
        renderer: requirePromptRenderer(),
        event,
        time
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
      let currentLoopStartedAt: string | undefined;
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
          isModeExpired: (session) => isModeExpired(session, time.now().epochMs),
          isStaticPromptChanged: (session) => session.mode !== "fixed_prefix" && session.staticPromptFingerprint !== fingerprint,
          shouldResetForTokenPressure: (session) => deps.config.llm.tokenPressureSessionResetEnabled
            && shouldResetSessionForTokenPressure({
              session,
              event,
              plugin: findToolPlugin(toolPlugins, "Chat"),
              model: deps.config.llm.model,
              contextImportance: deps.config.llm.tokenPressureContextImportance,
              noteLLMSessionUpdated
            }),
          modeFromSession: modeStateFromSession,
          clearSession(reason) {
            return clearLoopSession(reason ? () => deps.onLLMSessionCleared?.(reason as LLMSessionClearReason) : undefined);
          },
          async prepareSession(mode) {
            const preparedSession = await prepareChatLoopSessionContext({
              buildMessages: async () => {
                if (mode.mode === "fixed_prefix") return cloneLLMMessages(mode.modeStaticMessages);
                const initiatedMessages = await buildAgentInitiatedBehaviorMessages(initiatedBehavior, promptProfile, promptContext, async (layer, call) => {
                  const result = await runPromptToolRequest(call);
                  initiatedBehaviorPromptToolResult = result;
                  return result;
                });
                initiatedBehaviorMessageCount = initiatedMessages.length;
                return [
                  ...await buildPromptMessagesWithToolResults(promptProfile, promptContext, async (layer, call) => {
                    return runPromptToolRequest(call);
                  }),
                  ...initiatedMessages,
                  ...mode.modeStaticMessages
                ];
              },
              createSession(promptMessages): LLMSessionRecord {
                const sessionTime = time.now();
                return {
                  id: deps.createLLMSessionId(sessionTime.iso),
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
                  fixedPrefixStartedAt: mode.fixedPrefixStartedAt,
                  loopStartedAt: currentLoopStartedAt ?? failMissingLoopStartedAt(),
                  waitChatStartedAt: undefined
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
      let sessionRunStarted = false;
      let llmInput: ChatAgentLoopInput["llmInput"] | undefined;
      let preparedLoop: ReturnType<typeof buildChatAgentLoop> | undefined;
      const appendLoopSessionContext = deps.appendLoopSessionContext ?? appendAgentLoopSessionContext;
      const buildWaitResumeMessages = (session: LLMSessionRecord) => buildWaitChatResumeMessages({
        session,
        event,
        time,
        buildTextVariables: buildTurnTextVariables,
        onLLMLog: deps.onLLMLog
      });
      const clearWaitState = (session: LLMSessionRecord): void => {
        session.waitChatStartedAt = undefined;
        session.waitChatMode = undefined;
        session.waitChatUntil = undefined;
        session.waitChatTarget = undefined;
      };
      const appendSessionContext = async (session: LLMSessionRecord): Promise<void> => {
        if (persistedProcessRestart) {
          if (persistedProcessRestart.sessionId !== session.id) throw new Error("process_restart_session_mismatch");
          if (persistedProcessRestart.event.externalSession.sessionId !== event.externalSession.sessionId) {
            throw new Error("process_restart_external_session_mismatch");
          }
          return;
        }
        if (session.skipNextAppendLayers) return;
        const waitChatResumeMessages = await buildWaitResumeMessages(session);
        if (waitChatResumeMessages.length > 0) {
          clearWaitState(session);
          const result = appendLoopSessionContext({
            session,
            messages: waitChatResumeMessages,
            updateSession: noteLLMSessionUpdated
          });
          if (result.appended) {
            result.session.skipNextAppendLayers = true;
            noteLLMSessionUpdated(result.session);
          }
          return;
        }
        if (hasPendingWaitChatToolCall(session.messages)) return;
        const promptContext = buildPromptContext();
        if (createdSessionThisRun) return;
        const appendMessages = await buildAppendPromptMessagesWithToolResults(promptProfile, promptContext, (message, call) => {
          const preparedCall = {
            ...call,
            input: fixedPrefixToolInput(call.toolName, call.input, session)
          };
          return runPromptToolRequest(preparedCall, {
            context: {
              lastCompletedToolName,
              agentLoopRunSeq: session.agentLoopRunSeq,
              llmSessionId: session.id
            }
          });
        });
        if (appendMessages.length === 0) return;
        const result = appendLoopSessionContext({
          session,
          messages: appendMessages,
          updateSession: noteLLMSessionUpdated
        });
        if (result.appended) {
          result.session.skipNextAppendLayers = true;
          noteLLMSessionUpdated(result.session);
        }
      };
      return {
        async prepare() {
          currentLoopStartedAt = time.now().iso;
          if (loopSession) loopSession.loopStartedAt = currentLoopStartedAt;
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
          loopSession.loopStartedAt = currentLoopStartedAt;
          noteLLMSessionUpdated(loopSession);
          await appendSessionContext(loopSession);
          if (hasPendingWaitChatToolCall(loopSession.messages)) return [];
          const llmConfig = deps.getLLMConfig?.() ?? {
            client: deps.llm,
            model: deps.config.llm.model,
            temperature: deps.config.llm.temperature,
            maxTokens: undefined,
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
            maxTokens: llmConfig.maxTokens,
            extraParams: llmConfig.extraParams,
            followupExtraParams: llmConfig.followupExtraParams,
            presetName: llmConfig.presetName,
            stream: llmConfig.stream,
            supportsImage: llmConfig.supportsImage,
            supportsAudio: llmConfig.supportsAudio,
            toolNames: toolPlugins.flatMap((plugin) => plugin.listTools().map((tool) => tool.name)),
            assistantContentToolCall: {
              mode: "when_no_tool_calls",
              toolName: "Chat",
              input: { action: "send", type: "message" },
              contentInputKey: "content"
            }
          };
          const processRestartContinuation = matchingProcessRestartContinuation({
            record: persistedProcessRestart,
            session: loopSession,
            event
          });
          preparedLoop = buildChatAgentLoop({
            llmInput,
            event,
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
            promptProfile,
            async buildYieldResumeMessages(session) {
              const waitChatResumeMessages = await buildWaitResumeMessages(session as LLMSessionRecord);
              if (waitChatResumeMessages.length > 0) {
                clearWaitState(session as LLMSessionRecord);
                session.skipNextAppendLayers = true;
                noteLLMSessionUpdated(session as LLMSessionRecord);
              }
              return waitChatResumeMessages;
            },
            agentLoopRunSeq: loopSession.agentLoopRunSeq,
            signal: options.signal,
            processRestartContinuation,
            onProcessRestartCheckpoint: deps.processRestartContinuationStore ? (continuation) => {
              const interruptedCall = continuation.result.message.toolCalls?.[continuation.interruptedCallIndex];
              if (!interruptedCall) throw new Error("process_restart_interrupted_call_missing");
              const checkpointTime = time.now();
              activeProcessRestartToolCallId = interruptedCall.id;
              deps.processRestartContinuationStore!.save({
                version: 1,
                sessionId: loopSession!.id,
                toolCallId: interruptedCall.id,
                restartCompleted: false,
                event,
                continuation,
                createdAt: checkpointTime.iso
              });
            } : undefined,
            onProcessRestartProgress: deps.processRestartContinuationStore && persistedProcessRestart ? (continuation) => {
              deps.processRestartContinuationStore!.save({
                ...persistedProcessRestart,
                restartCompleted: true,
                continuation
              });
            } : undefined,
            onProcessRestartCancelled: deps.processRestartContinuationStore ? () => {
              if (activeProcessRestartToolCallId) {
                deps.processRestartContinuationStore!.clear(activeProcessRestartToolCallId);
              }
            } : undefined,
            processRestartRecoveryActive: persistedProcessRestart !== undefined,
            onProcessRestartResponseReceived: deps.processRestartContinuationStore ? () => {
              if (activeProcessRestartToolCallId) {
                deps.processRestartContinuationStore!.clear(activeProcessRestartToolCallId);
                activeProcessRestartToolCallId = undefined;
              }
            } : undefined,
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
          if (sessionRunStarted) deps.onLLMSessionCompleted?.();
        },
        complete(loopResult) {
          if (!preparedLoop) return [];
          const llmResult = preparedLoop.complete(loopResult);
          if (!llmResult.cancelled && activeProcessRestartToolCallId) {
            deps.processRestartContinuationStore?.clear(activeProcessRestartToolCallId);
          }
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
            clearLoopSession(() => deps.onLLMSessionCleared?.(llmResult.clearReason ?? "prompt_static_changed"));
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

  function buildTurnTextVariables(_event: AgentEvent): PromptContextRuntime {
    return requirePromptRenderer();
  }

  function requirePromptRenderer(): PromptContextRuntime {
    return deps.getPromptRenderer();
  }

  function requirePromptProfile(): PromptProfile {
    const profile = deps.getPromptProfile?.();
    if (!profile) throw new Error("ChatAgent requires getPromptProfile");
    return profile;
  }

  function noteLLMSessionUpdated(session: LLMSessionRecord): void {
    deps.onLLMSessionUpdated?.(createLLMSessionSnapshot(session));
  }
}

function matchingProcessRestartContinuation(input: {
  record: ProcessRestartContinuationRecord | undefined;
  session: LLMSessionRecord;
  event: AgentEvent;
}): ChatAgentLoopInput["processRestartContinuation"] | undefined {
  const { record, session, event } = input;
  if (!record) return undefined;
  if (record.sessionId !== session.id) throw new Error("process_restart_session_mismatch");
  if (record.event.externalSession.sessionId !== event.externalSession.sessionId) {
    throw new Error("process_restart_external_session_mismatch");
  }
  const completedToolCallIds = new Set(session.messages
    .filter((message) => message.role === "tool" && typeof message.toolCallId === "string")
    .map((message) => message.toolCallId));
  const allCallsCompleted = (record.continuation.result.message.toolCalls ?? [])
    .every((call) => completedToolCallIds.has(call.id));
  if (record.restartCompleted && allCallsCompleted) return undefined;
  if (record.restartCompleted) return { snapshot: record.continuation };
  const interruptedCall = record.continuation.result.message.toolCalls?.[record.continuation.interruptedCallIndex];
  if (interruptedCall?.id !== record.toolCallId) throw new Error("process_restart_tool_call_mismatch");
  return {
    snapshot: record.continuation,
    interruptedToolResult: {
      callId: record.toolCallId,
      ok: true,
      output: restartSuccessOutput
    }
  };
}

function matchesPersistedProcessRestartTranscript(
  record: ProcessRestartContinuationRecord,
  session: LLMSessionRecord,
  event: AgentEvent
): boolean {
  if (record.sessionId !== session.id) return false;
  if (record.event.externalSession.sessionId !== event.externalSession.sessionId) return false;
  const interruptedCall = record.continuation.result.message.toolCalls?.[record.continuation.interruptedCallIndex];
  if (interruptedCall?.id !== record.toolCallId || interruptedCall.function.name !== restartToolName) return false;
  return true;
}

async function failRunIndicatorOnRecoveryFailure(deps: ChatAgentDeps): Promise<void> {
  if (!deps.agentRunIndicator?.fail) return;
  try {
    await deps.agentRunIndicator.fail(new Error("process_restart_recovery_failed"));
  } catch (error) {
    deps.onAgentRunIndicatorError?.(error);
  }
}
