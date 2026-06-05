import type { AppConfig } from "../../../packages/config/src/index.js";
import type { LLMChatInput, LLMChatResult, LLMClient, LLMToolCall, LLMToolCallDelta } from "../../llm/src/index.js";
import type { OutputRouter } from "../../output-router/src/index.js";
import type { PolicyEngine } from "../../policy/src/index.js";
import type { IntentRouter } from "../../router/src/index.js";
import type { SessionResolver } from "../../session/src/index.js";
import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../time/src/index.js";
import type { AgentEvent, AgentOutput, ChannelPlugin, ToolPlugin, ToolResult } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import { buildAppendPromptMessagesWithToolResults, buildPromptMessagesWithToolResults, defaultPromptProfile, staticPromptFingerprint, type PromptLayer, type PromptProfile } from "./prompts.js";
import type { AgentStateController, AgentStateSnapshot } from "./state.js";
import type { DailyShell } from "./shells.js";
import type { MemorySnapshot } from "./memory.js";
import { buildLLMTextVariables, formatToolResultForLLM as renderToolResultForLLM, renderLLMValue, type LLMTextVariables } from "../../text-renderer/src/index.js";
import { deepSeekPriceForModel } from "../../../packages/config/src/token-pricing.js";
import { runLLMToolLoop, type LLMRequestSender, type LLMToolLoopExecution } from "./llm-tool-loop.js";

const sendChatToolName = "send_chat";
const maxLLMRequestsPerMinute = 10;
const maxLLMRetryAttempts = 3;
const fixedPrefixDefaultTtlMs = 2 * 60 * 60 * 1000;

export type LLMSessionClearReason = "prompt_static_changed" | "admin_clear" | "admin_cancel" | "shutdown" | "token_pressure" | "mode_transition" | "mode_timeout";
export type LLMSessionSnapshot = {
  messages: LLMChatInput["messages"];
  staticPromptFingerprint?: string;
  staticPromptMessageCount?: number;
  requestTimestamps?: string[];
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

type ModeState = {
  mode: string;
  modeStaticMessages: LLMChatInput["messages"];
  modeStaticTokenEstimate: number;
  tokenPressurePreviewBaselines: Record<string, TokenPressurePreviewBaseline>;
  modeStartedAt?: number;
  modeExpiresAt?: number;
  fixedPrefixKind?: string;
  fixedPrefixCursorMessageId?: number;
};

type CoreLLMTurnInput = {
  messages: LLMChatInput["messages"];
  client?: LLMClient;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  extraParams?: Record<string, unknown>;
  followupExtraParams?: Record<string, unknown>;
  stream?: boolean;
  toolNames: string[];
};

type CoreLLMRuntimeConfig = {
  client?: LLMClient;
  model?: string;
  temperature?: number;
  extraParams?: Record<string, unknown>;
  followupExtraParams?: Record<string, unknown>;
  stream?: boolean;
};

export type AgentCoreDeps = {
  config: AppConfig;
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
  getMemorySnapshot?: () => MemorySnapshot;
  state?: AgentStateController;
  time?: CurrentTimeProvider;
  onLLMRequestPrepared?(input: LLMChatInput): void;
  onLLMResponseReceived?(result: LLMChatResult): void;
  llmRequestSender?: LLMRequestSender;
  getLLMConfig?: () => CoreLLMRuntimeConfig;
  isLLMRunCancelled?(): boolean;
  onLLMLog?(event: { kind: "call_start" | "stream_start" | "stream_end" | "response_received" | "rate_limited" | "retry" | "wait_chat_resume_error"; round: number; stream: boolean; model?: string; attempt?: number; error?: string; delayMs?: number }): void;
  onLLMHeartbeatStarted?(): void;
  onLLMSessionUpdated?(session: LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] }): void;
  onLLMSessionCleared?(reason: LLMSessionClearReason): void;
  onLLMSessionRebuilt?(): void;
  onLLMSessionCompleted?(result: { sentMessage: boolean }): void;
  initialLLMSession?: LLMSessionSnapshot;
  loadLLMSession?(): LLMSessionSnapshot | undefined;
};

export interface AgentCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleEvent(event: AgentEvent): Promise<AgentOutput[]>;
  getState(): AgentStateSnapshot | undefined;
  registerChannel(plugin: ChannelPlugin): void;
  clearLLMSession(reason: LLMSessionClearReason): void;
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const channels: ChannelPlugin[] = [];
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  let lastCompletedToolName: string | undefined;
  let nextAppendToolCallId = 1;
  type ActiveLLMSession = {
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
    hydratedFixedPrefixPendingRebuild?: boolean;
  };
  let activeLLMSession: ActiveLLMSession | undefined = deps.initialLLMSession?.staticPromptFingerprint
    ? hydrateLLMSessionSnapshot(deps.initialLLMSession)
    : undefined;
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
      if (!activeLLMSession) return;
      activeLLMSession = undefined;
      deps.onLLMSessionCleared?.(reason);
    },
    async handleEvent(event) {
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
        session: { ...event.session, sessionId }
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

      const promptProfile = deps.getPromptProfile?.() ?? defaultPromptProfile();
      const toolPlugins = filterVisibleTools(deps.tools ?? [], promptProfile);
      let sleepCocoonInstruction = sleepCocoonGeneratedInstruction(event, promptProfile.userName);
      if (deps.loadLLMSession) {
        const persistedSession = deps.loadLLMSession();
        activeLLMSession = persistedSession?.staticPromptFingerprint
          ? hydrateLLMSessionSnapshot(persistedSession)
          : undefined;
      }
      const makePromptContext = () => ({
        event,
        time,
        dailyShell: deps.getDailyShell?.(),
        dailyShellRaw: deps.getDailyShellRaw?.(),
        appearanceDescription: deps.getAppearanceDescription?.(),
        memory: deps.getMemorySnapshot?.()
      });
      const ensureActiveLLMSession = async (): Promise<ActiveLLMSession> => {
        const promptContext = makePromptContext();
        const fingerprint = staticPromptFingerprint(promptProfile, promptContext);
        if (sleepCocoonInstruction && activeLLMSession && !applyModeStateToNewSession) {
          deps.onLLMSessionCleared?.("mode_transition");
          activeLLMSession = undefined;
        }
        if (activeLLMSession && isModeExpired(activeLLMSession)) {
          deps.onLLMSessionCleared?.("mode_timeout");
          activeLLMSession = undefined;
          applyModeStateToNewSession = defaultModeState();
        }
        if (activeLLMSession?.hydratedFixedPrefixPendingRebuild && !applyModeStateToNewSession) {
          const mode = modeStateFromSession(activeLLMSession);
          activeLLMSession = undefined;
          applyModeStateToNewSession = mode;
        }
        if (activeLLMSession && activeLLMSession.mode !== "fixed_prefix" && activeLLMSession.staticPromptFingerprint !== fingerprint) {
          const mode = modeStateFromSession(activeLLMSession);
          deps.onLLMSessionCleared?.("prompt_static_changed");
          activeLLMSession = undefined;
          applyModeStateToNewSession = mode;
        }
        if (activeLLMSession
          && await shouldResetSessionForTokenPressure(activeLLMSession, event, findToolPlugin(toolPlugins, "check_chat"))) {
          const mode = modeStateFromSession(activeLLMSession);
          activeLLMSession = undefined;
          deps.onLLMSessionCleared?.("token_pressure");
          applyModeStateToNewSession = mode;
        }
        if (!activeLLMSession) {
          const mode = applyModeStateToNewSession ?? defaultModeState();
          applyModeStateToNewSession = undefined;
          let promptCheckChatCursor: number | undefined;
          const promptMessages = mode.mode === "fixed_prefix"
            ? cloneLLMMessages(mode.modeStaticMessages)
            : [
              ...await buildPromptMessagesWithToolResults(promptProfile, promptContext, async (layer, call) => {
                const result = await runPromptToolRequest(layer, call, toolPlugins);
                promptCheckChatCursor = checkChatCursorFromResult(call.toolName, result) ?? promptCheckChatCursor;
                return result;
              }),
              ...(sleepCocoonInstruction ? [{ role: "user" as const, content: sleepCocoonInstruction }] : []),
              ...mode.modeStaticMessages
            ];
          sleepCocoonInstruction = undefined;
          activeLLMSession = {
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
          noteLLMSessionUpdated();
        }
        if (!activeLLMSession) throw new Error("llm_session_unavailable");
        return activeLLMSession;
      };
      await ensureActiveLLMSession();
      if (!activeLLMSession || activeLLMSession.messages.length === 0) {
        return [];
      }
      deps.onLLMHeartbeatStarted?.();
      let sentMessage = false;
      try {
        const appendSessionContext = async (session: ActiveLLMSession): Promise<void> => {
          const waitChatResumeMessages = await buildWaitChatResumeMessages(session, event, toolPlugins);
          if (waitChatResumeMessages.length > 0) {
            session.messages = [
              ...session.messages,
              ...waitChatResumeMessages
            ];
            session.waitChatStartedAt = undefined;
            noteLLMSessionUpdated();
            return;
          }
          const promptContext = makePromptContext();
          if (session.mode === "fixed_prefix") {
            const appendMessages = await buildFixedPrefixAppendMessages(modeStateFromSession(session), event, toolPlugins);
            if (appendMessages.length === 0) return;
            session.messages = [
              ...session.messages,
              ...appendMessages
            ];
            noteLLMSessionUpdated();
            return;
          }
          const appendProfile = {
            ...promptProfile,
            appendLayers: (promptProfile.appendLayers ?? []).filter((layer) => (
              layer.role !== "tool_request" || Boolean(findToolPlugin(toolPlugins, layer.toolName || "check_chat"))
            )).map((layer) => {
              if (layer.role !== "tool_request") return layer;
              return {
                ...layer,
                toolCallId: layer.toolCallId ?? `append_${layer.id}_${nextAppendToolCallId++}`
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
          session.messages = [
            ...session.messages,
            ...appendMessages
          ];
          noteLLMSessionUpdated();
        };
        await appendSessionContext(activeLLMSession);
        const llmConfig = deps.getLLMConfig?.() ?? {
          client: deps.llm,
          model: deps.config.llm.model,
          temperature: deps.config.llm.temperature,
          extraParams: deps.config.llm.extraParams,
          followupExtraParams: deps.config.llm.followupExtraParams,
          stream: deps.config.llm.stream
        };
        const llmInput: CoreLLMTurnInput = {
          messages: activeLLMSession.messages,
          client: llmConfig.client,
          model: llmConfig.model,
          temperature: llmConfig.temperature,
          extraParams: llmConfig.extraParams,
          followupExtraParams: llmConfig.followupExtraParams,
          stream: llmConfig.stream,
          toolNames: toolPlugins.flatMap((plugin) => plugin.listTools().map((tool) => tool.name))
        };
        const llmResult = await runLLMTurnWithTools(llmInput, event, toolPlugins, activeLLMSession, ensureActiveLLMSession, appendSessionContext);
        sentMessage = llmResult.sentMessage;
        if (llmResult.cancelled) {
          if (activeLLMSession) {
            deps.onLLMSessionCleared?.("admin_cancel");
            activeLLMSession = undefined;
          }
          return [];
        }
        if (llmResult.invalidateSession) {
          deps.onLLMSessionCleared?.("prompt_static_changed");
          activeLLMSession = undefined;
        }
        const usage = llmResult.finalResult?.usage;
        const usageModel = llmResult.finalResult?.model ?? llmInput.model;
        if (activeLLMSession && usage) {
          if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
            activeLLMSession.lastTotalTokens = usage.totalTokens;
          }
          if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
            activeLLMSession.lastInputTokens = usage.inputTokens;
          }
          if (usageModel) activeLLMSession.lastUsageModel = usageModel;
          noteLLMSessionUpdated();
        }
      } finally {
        deps.onLLMSessionCompleted?.({ sentMessage });
      }

      return [];
    }
  };

  async function runLLMTurnWithTools(
    input: CoreLLMTurnInput,
    event: AgentEvent,
    toolPlugins: ToolPlugin[],
    session: ActiveLLMSession,
    ensureSession: () => Promise<ActiveLLMSession>,
    appendSessionContext: (session: ActiveLLMSession) => Promise<void>
  ): Promise<{ message: LLMChatInput["messages"][number]; sentMessage: boolean; invalidateSession?: boolean; cancelled?: boolean; finalResult?: LLMChatResult }> {
    const toolMap = new Map<string, ToolPlugin>();
    const visibleToolNames = input.toolNames;
    for (const plugin of toolPlugins) {
      for (const tool of plugin.listTools()) {
        toolMap.set(tool.name, plugin);
      }
      if (plugin.id === "messaging" && toolMap.has(sendChatToolName)) {
        toolMap.set("check_feishu", plugin);
        toolMap.set("check_wechat", plugin);
        toolMap.set("view_messages", plugin);
        toolMap.set("send_feishu", plugin);
        toolMap.set("send_wechat", plugin);
        toolMap.set("send_message", plugin);
      }
    }

    let sendChatCallCount = 0;
    let streamingToolSender: ReturnType<typeof createStreamingSendMessageHandler> | undefined;
    const loopResult = await runLLMToolLoop({
      initialMessages: session.messages,
      limits: { maxRounds: 20, maxTotalToolCalls: 20, maxRepeatedToolCalls: 3 },
      async beforeRound({ round }) {
        if (deps.isLLMRunCancelled?.()) return { stop: true, messages: session.messages };
        const ensuredSession = await ensureSession();
        if (ensuredSession !== session) {
          session = ensuredSession;
          await appendSessionContext(session);
        }
        if (session.messages.length === 0) return { stop: true, messages: session.messages };
        const requestTime = time.now().epochMs;
        session.requestTimestamps = session.requestTimestamps.filter((timestamp) => requestTime - timestamp < 60_000);
        if (session.requestTimestamps.length >= maxLLMRequestsPerMinute) {
          deps.onLLMLog?.({ kind: "rate_limited", round, stream: false, model: input.model });
          noteLLMSessionUpdated();
          return { stop: true, messages: session.messages };
        }
        session.requestTimestamps.push(requestTime);
        noteLLMSessionUpdated();
        return { messages: session.messages };
      },
      buildRequest({ round, messages }) {
        streamingToolSender = createStreamingSendMessageHandler(event, toolMap);
        return {
          agentId: "core",
          client: input.client ?? deps.llm,
          messages,
          model: input.model,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          extraParams: round === 0 ? input.extraParams : input.followupExtraParams,
          toolNames: visibleToolNames,
          toolVariables: buildTurnTextVariables(event),
          stream: input.stream !== false && Boolean((input.client ?? deps.llm).chatStream),
          streamHandlers: {
            onToolCallDelta(delta) {
              return streamingToolSender?.onToolCallDelta(delta);
            }
          }
        };
      },
      sendRequest: deps.llmRequestSender ?? createLocalLLMRequestSender(toolPlugins),
      async afterRequest() {
        await streamingToolSender?.finish();
      },
      shouldCancel() {
        return deps.isLLMRunCancelled?.() === true;
      },
      selectToolCalls(calls) {
        if (calls.some((call) => isWaitChatToolName(call.function.name))) return calls;
        return calls.some((call) => isSendChatToolName(call.function.name))
          ? calls.filter((call) => isSendChatToolName(call.function.name))
          : calls;
      },
      shouldYieldReturn(calls) {
        return calls.some((call) => isWaitChatToolName(call.function.name));
      },
      shouldDeferToolResult(call, calls) {
        return calls.some((entry) => isWaitChatToolName(entry.function.name))
          && isInboundToolName(call.function.name);
      },
      async executeTool(call, { result }): Promise<LLMToolLoopExecution> {
        const textVariables = buildTurnTextVariables(event);
        const isConsecutiveSelfie = call.function.name === "selfie" && lastCompletedToolName === "selfie";
        let reachedToolCallLimit = false;
        if (isSendChatToolName(call.function.name)) {
          sendChatCallCount += 1;
          if (sendChatCallCount >= 5) reachedToolCallLimit = true;
        }
        const streamedResult = streamingToolSender?.resultFor(call.id);
        if (streamedResult) {
          session.lastCheckChatCursorMessageId = checkChatCursorFromResult(call.function.name, streamedResult) ?? session.lastCheckChatCursorMessageId;
          lastCompletedToolName = call.function.name;
          return {
            message: {
              role: "tool" as const,
              toolCallId: call.id,
              name: call.function.name,
              content: formatToolResultForLLM(streamedResult, textVariables)
            },
            control: {
              sentMessage: isSendChatToolName(call.function.name) && streamedResult.ok,
              invalidateSession: streamedResult.invalidateLLMSession === true,
              yieldReturn: streamedResult.meta?.yieldReturn === true,
              reachedToolCallLimit
            }
          };
        }
        const plugin = toolMap.get(call.function.name);
        let toolResult: ToolResult;
        if (isConsecutiveSelfie) {
          toolResult = {
            callId: call.id,
            ok: false,
            error: "selfie cannot be called twice in a row"
          };
        } else if (!plugin) {
          toolResult = {
            callId: call.id,
            ok: false,
            error: `Unknown tool: ${call.function.name}`
          };
        } else {
          try {
            if (isSendChatToolName(call.function.name) && hasUnsafeSendChatArguments(call.function.arguments)) {
              toolResult = {
                callId: call.id,
                ok: false,
                error: "unsafe send_chat arguments"
              };
            } else {
              const input = fixedPrefixToolInput(call.function.name, parseToolArguments(call.function.arguments), session);
              toolResult = await plugin.execute({
                id: call.id,
                toolName: call.function.name,
                input,
                requester: event.source,
                session: event.session
              });
            }
          } catch (error) {
            toolResult = {
              callId: call.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }

        session.lastCheckChatCursorMessageId = checkChatCursorFromResult(call.function.name, toolResult) ?? session.lastCheckChatCursorMessageId;
        if (isWaitChatToolName(call.function.name) && toolResult.meta?.yieldReturn === true) {
          session.waitChatStartedAt = time.now().epochMs;
        }
        lastCompletedToolName = call.function.name;
        const toolMessage = {
          role: "tool" as const,
          toolCallId: call.id,
          name: call.function.name,
          content: formatToolResultForLLM(toolResult, textVariables)
        };
        const control = {
          sentMessage: isSendChatToolName(call.function.name) && toolResult.ok,
          invalidateSession: toolResult.invalidateLLMSession === true,
          yieldReturn: toolResult.meta?.yieldReturn === true,
          reachedToolCallLimit,
          resetSession: false,
          continueAfterReset: false
        };
        if (toolResult.resetLLMSession) {
          if (toolResult.clearFixedPrefix) {
            applyModeStateToNewSession = defaultModeState();
            activeLLMSession = undefined;
            return { message: toolMessage, control: { ...control, resetSession: true, continueAfterReset: false, invalidateSession: true } };
          }
          const fixedPrefixKind = typeof toolResult.fixedPrefixKind === "string" && toolResult.fixedPrefixKind
            ? toolResult.fixedPrefixKind
            : undefined;
          const mode = fixedPrefixKind ? "fixed_prefix" : toolResult.llmSessionMode || "normal";
          const modeStaticMessages = mode === "fixed_prefix"
            ? [
              ...cloneLLMMessages(session.messages),
              {
                role: "assistant" as const,
                content: result.message.content,
                reasoningContent: reasoningContentForToolRequest(result.message.reasoningContent, 1),
                toolCalls: [call]
              },
              toolMessage
            ]
            : mode === "normal"
              ? []
              : cloneLLMMessages((toolResult.llmSessionStaticMessages as LLMChatInput["messages"] | undefined) ?? [
                {
                  role: "assistant" as const,
                  content: result.message.content,
                  reasoningContent: reasoningContentForToolRequest(result.message.reasoningContent, 1),
                  toolCalls: [call]
                },
                toolMessage
              ]);
          const modeStartedAt = mode === "normal" ? undefined : time.now().epochMs;
          const ttlMs = Number.isFinite(toolResult.fixedPrefixTtlMs) ? Number(toolResult.fixedPrefixTtlMs) : fixedPrefixDefaultTtlMs;
          applyModeStateToNewSession = {
            mode,
            modeStaticMessages,
            modeStaticTokenEstimate: estimateMessagesTokens(modeStaticMessages),
            tokenPressurePreviewBaselines: {},
            modeStartedAt,
            modeExpiresAt: mode === "fixed_prefix" && typeof modeStartedAt === "number" ? modeStartedAt + ttlMs : undefined,
            fixedPrefixKind,
            fixedPrefixCursorMessageId: mode === "fixed_prefix" ? session.lastCheckChatCursorMessageId : undefined
          };
          activeLLMSession = undefined;
          const shouldContinueAfterReset = mode === "fixed_prefix" || mode !== "normal";
          if (shouldContinueAfterReset) deps.onLLMSessionRebuilt?.();
          return {
            message: toolMessage,
            control: {
              ...control,
              resetSession: true,
              continueAfterReset: shouldContinueAfterReset,
              invalidateSession: control.invalidateSession || mode === "normal"
            }
          };
        }
        return { message: toolMessage, control };
      },
      async onMessagesChanged({ messages }) {
        session.messages = messages;
        noteLLMSessionUpdated();
      }
    });
    if (loopResult.stopReason === "reset") {
      noteLLMSessionUpdated();
    }
    return {
      message: loopResult.finalMessage,
      sentMessage: loopResult.sentMessage,
      invalidateSession: loopResult.invalidateSession,
      cancelled: loopResult.stopReason === "cancelled",
      finalResult: loopResult.finalResult
    };
  }

  function buildTurnTextVariables(event: AgentEvent): LLMTextVariables {
    return buildLLMTextVariables({
      userName: (deps.getPromptProfile?.() ?? defaultPromptProfile()).userName,
      time,
      event,
      dailyShell: deps.getDailyShell?.(),
      dailyShellRaw: deps.getDailyShellRaw?.(),
      appearanceDescription: deps.getAppearanceDescription?.(),
      memory: deps.getMemorySnapshot?.()
    });
  }

  function createLocalLLMRequestSender(toolPlugins: ToolPlugin[]): LLMRequestSender {
    return async (input) => {
      const client = input.client ?? deps.llm;
      const requestInput: LLMChatInput = {
        messages: input.messages,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        extraParams: input.extraParams,
        tools: buildLocalToolSpecs(toolPlugins, input.toolNames, input.toolVariables as LLMTextVariables | undefined)
      };
      deps.onLLMRequestPrepared?.(requestInput);
      const useStream = input.stream === true && Boolean(client.chatStream);
      let lastError: unknown;
      let result: LLMChatResult | undefined;
      for (let attempt = 1; attempt <= maxLLMRetryAttempts; attempt += 1) {
        deps.onLLMLog?.({ kind: "call_start", round: input.round, stream: useStream, model: requestInput.model, attempt });
        try {
          if (useStream && client.chatStream) {
            deps.onLLMLog?.({ kind: "stream_start", round: input.round, stream: true, model: requestInput.model, attempt });
            try {
              result = await client.chatStream(requestInput, input.streamHandlers);
            } finally {
              deps.onLLMLog?.({ kind: "stream_end", round: input.round, stream: true, model: requestInput.model, attempt });
            }
          } else {
            result = await client.chat(requestInput);
            deps.onLLMLog?.({ kind: "response_received", round: input.round, stream: false, model: requestInput.model, attempt });
          }
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= maxLLMRetryAttempts || !isRetryableLLMError(error)) throw error;
          const delayMs = llmRetryDelayMs(attempt);
          deps.onLLMLog?.({
            kind: "retry",
            round: input.round,
            stream: useStream,
            model: requestInput.model,
            attempt,
            error: error instanceof Error ? error.message : String(error),
            delayMs
          });
          await sleep(delayMs);
        }
      }
      if (!result) throw lastError;
      deps.onLLMResponseReceived?.(result);
      return result;
    };
  }

  function buildLocalToolSpecs(toolPlugins: ToolPlugin[], toolNames: string[], variables?: LLMTextVariables): LLMChatInput["tools"] {
    const seen = new Set<string>();
    const specs: LLMChatInput["tools"] = [];
    for (const name of toolNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      const plugin = findToolPlugin(toolPlugins, name);
      const tool = plugin?.listTools().find((entry) => entry.name === name);
      if (!tool) throw new Error(`unknown LLM tool: ${name}`);
      specs.push({
        type: "function",
        function: {
          name: tool.name,
          description: renderLLMTextValue(tool.description, variables ?? {}),
          parameters: renderLLMValue(tool.inputSchema, variables ?? {}) as Record<string, unknown>
        }
      });
    }
    return specs;
  }

  function createStreamingSendMessageHandler(event: AgentEvent, toolMap: Map<string, ToolPlugin>) {
    const states = new Map<number, StreamingSendMessageState>();
    const resultsByCallId = new Map<string, ToolResult>();
    const sentCounts = new Map<string, number>();
    let sendChain = Promise.resolve();

    return {
      onToolCallDelta(delta: LLMToolCallDelta) {
        const state = states.get(delta.index) ?? new StreamingSendMessageState();
        states.set(delta.index, state);
        const { readyLines } = state.accept(delta);
        const callId = state.callId;
        const plugin = toolMap.get(sendChatToolName);
        if (!callId || !plugin || !isSendChatToolName(state.toolName)) {
          state.restoreReadyLines(readyLines);
          return;
        }
        const lines = state.canStreamNow() && !state.hasUnsafeArguments() ? state.stageStreamingLines(readyLines) : [];
        if (lines.length === 0) return;
        state.dropPendingLines();
        sendChain = sendChain.then(async () => {
          const sendType = state.sendType();
          for (const line of lines) {
            const sentCount = sentCounts.get(callId) ?? 0;
            await sendStreamingLine(plugin, event, callId, sendType, line, resultsByCallId);
            sentCounts.set(callId, sentCount + 1);
          }
        });
      },
      async finish() {
        for (const state of states.values()) {
          if (state.hasUnsafeArguments()) continue;
          const lines = state.finish();
          const callId = state.callId;
          const plugin = toolMap.get(sendChatToolName);
          if (!callId || !plugin || !isSendChatToolName(state.toolName) || !state.shouldSendAsStreamingType()) continue;
          sendChain = sendChain.then(async () => {
            const sendType = state.sendType();
            for (const line of lines) {
              const sentCount = sentCounts.get(callId) ?? 0;
              await sendStreamingLine(plugin, event, callId, sendType, line, resultsByCallId);
              sentCounts.set(callId, sentCount + 1);
            }
          });
        }
        await sendChain;
      },
      resultFor(callId: string) {
        return resultsByCallId.get(callId);
      }
    };
  }

  async function runPromptToolRequest(
    layer: PromptLayer,
    call: {
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      requester?: AgentEvent["source"];
      session?: AgentEvent["session"];
    },
    toolPlugins: ToolPlugin[]
  ): Promise<ToolResult> {
    if (isSendChatToolName(call.toolName)) {
      return {
        callId: call.id,
        ok: false,
        error: "send_chat cannot run from prompt prebuild"
      };
    }
    const plugin = findToolPlugin(toolPlugins, call.toolName);
    if (!plugin) {
      return {
        callId: call.id,
        ok: false,
        error: `Unknown prompt tool: ${call.toolName}`
      };
    }
    try {
      return await plugin.execute(call);
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async function buildFixedPrefixAppendMessages(
    mode: ModeState,
    event: AgentEvent,
    toolPlugins: ToolPlugin[]
  ): Promise<LLMChatInput["messages"]> {
    const messages: LLMChatInput["messages"] = [];
    const plugin = findToolPlugin(toolPlugins, "check_chat");
    if (!plugin) return messages;
    const callId = `append_fixed_prefix_check_chat_${nextAppendToolCallId++}`;
    const publicArguments = {};
    const result = await runPromptToolRequest(
      { id: "fixed_prefix_check_chat", title: "Fixed prefix check", role: "tool_request", enabled: true, content: "", toolName: "check_chat", toolArguments: JSON.stringify(publicArguments), order: 0 },
      {
        id: callId,
        toolName: "check_chat",
        input: { scope: "from_prefix", __fromPrefixAfterMessageId: mode.fixedPrefixCursorMessageId ?? 0 },
        requester: event.source,
        session: event.session
      },
      toolPlugins
    );
    messages.push({
      role: "assistant",
      content: "",
      reasoningContent: "Check messages after the fixed prefix cursor.",
      toolCalls: [{
        id: callId,
        type: "function",
        function: {
          name: "check_chat",
          arguments: JSON.stringify(publicArguments)
        }
      }]
    });
    messages.push({
      role: "tool",
      toolCallId: callId,
      name: "check_chat",
      content: formatToolResultForLLM(result, buildTurnTextVariables(event))
    });
    return messages;
  }

  async function buildWaitChatResumeMessages(
    session: ActiveLLMSession,
    event: AgentEvent,
    toolPlugins: ToolPlugin[]
  ): Promise<LLMChatInput["messages"]> {
    const pending = pendingWaitChatToolCalls(session.messages);
    if (!pending) return [];
    const messages: LLMChatInput["messages"] = [];
    const textVariables = buildTurnTextVariables(event);
    let waitChatCheckResult: ToolResult | undefined;
    for (const call of pending.calls) {
      let result: ToolResult;
      if (isWaitChatToolName(call.function.name)) {
        waitChatCheckResult ??= await runWaitChatResumeCheck(call.id, session, event, toolPlugins);
        result = {
          ...waitChatCheckResult,
          callId: call.id,
          output: formatWaitChatResumeOutput(waitChatCheckResult, session.waitChatStartedAt)
        };
      } else {
        const input = fixedPrefixToolInput(call.function.name, parseToolArguments(call.function.arguments), session);
        result = await runPromptToolRequest(
          { id: `wait_chat_resume_${call.id}`, title: "wait_chat resume", role: "tool_request", enabled: true, content: "", toolName: call.function.name, toolArguments: call.function.arguments, order: 0 },
          {
            id: call.id,
            toolName: call.function.name,
            input,
            requester: event.source,
            session: event.session
          },
          toolPlugins
        );
        session.lastCheckChatCursorMessageId = checkChatCursorFromResult(call.function.name, result) ?? session.lastCheckChatCursorMessageId;
        if (isCheckChatToolName(call.function.name)) waitChatCheckResult ??= result;
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.function.name,
        content: formatToolResultForLLM(result, textVariables)
      });
    }
    return messages;
  }

  async function runWaitChatResumeCheck(
    callId: string,
    session: ActiveLLMSession,
    event: AgentEvent,
    toolPlugins: ToolPlugin[]
  ): Promise<ToolResult> {
    const checkInput = session.mode === "fixed_prefix"
      ? { scope: "from_prefix", __fromPrefixAfterMessageId: session.fixedPrefixCursorMessageId ?? 0 }
      : {};
    const result = await runPromptToolRequest(
      { id: "wait_chat_resume_check_chat", title: "wait_chat resume", role: "tool_request", enabled: true, content: "", toolName: "check_chat", toolArguments: "{}", order: 0 },
      {
        id: callId,
        toolName: "check_chat",
        input: checkInput,
        requester: event.source,
        session: event.session
      },
      toolPlugins
    );
    session.lastCheckChatCursorMessageId = checkChatCursorFromResult("check_chat", result) ?? session.lastCheckChatCursorMessageId;
    return result;
  }

  function pendingWaitChatToolCalls(messages: LLMChatInput["messages"]): { calls: LLMToolCall[] } | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) continue;
      const followingToolCallIds = new Set(
        messages
          .slice(index + 1)
          .filter((entry) => entry.role === "tool" && typeof entry.toolCallId === "string")
          .map((entry) => entry.toolCallId as string)
      );
      const missingCalls = message.toolCalls.filter((call) => !followingToolCallIds.has(call.id));
      if (!missingCalls.some((call) => isWaitChatToolName(call.function.name))) return undefined;
      return { calls: missingCalls };
    }
    return undefined;
  }

  function formatWaitChatResumeOutput(result: ToolResult, waitChatStartedAt: number | undefined): unknown {
    if (typeof result.output !== "string") return result.output;
    if (typeof waitChatStartedAt !== "number" || !Number.isFinite(waitChatStartedAt)) {
      deps.onLLMLog?.({
        kind: "wait_chat_resume_error",
        round: 0,
        stream: false,
        error: "wait_chat resume missing start time"
      });
      return result.output;
    }
    const duration = formatWaitChatDuration(time.now().epochMs - waitChatStartedAt);
    if (!duration) return result.output;
    const timeMarker = "\n<time>";
    const index = result.output.lastIndexOf(timeMarker);
    if (index === -1) return `${result.output}\n<wait-duration>${duration}</wait-duration>`;
    return `${result.output.slice(0, index)}\n<wait-duration>${duration}</wait-duration>${result.output.slice(index)}`;
  }

  function formatWaitChatDuration(durationMs: number): string | undefined {
    if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
    const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
  }

  function fixedPrefixToolInput(toolName: string, input: Record<string, unknown>, session: ActiveLLMSession): Record<string, unknown> {
    if (
      session.mode !== "fixed_prefix"
      || !isCheckChatToolName(toolName)
      || input.scope !== "from_prefix"
      || typeof input.__fromPrefixAfterMessageId === "number"
    ) {
      return input;
    }
    return {
      ...input,
      __fromPrefixAfterMessageId: session.fixedPrefixCursorMessageId ?? 0
    };
  }

  function checkChatCursorFromResult(toolName: string, result: ToolResult): number | undefined {
    if (!isCheckChatToolName(toolName)) return undefined;
    return typeof result.messageCursorId === "number" && Number.isFinite(result.messageCursorId) ? result.messageCursorId : undefined;
  }

  function isCheckChatToolName(toolName: string): boolean {
    return toolName === "check_chat" || toolName === "check_feishu" || toolName === "check_wechat" || toolName === "view_messages";
  }

  function isInboundToolName(toolName: string | undefined): boolean {
    return isCheckChatToolName(toolName ?? "") || toolName === "search_messages";
  }

  async function shouldResetSessionForTokenPressure(
    session: ActiveLLMSession,
    event: AgentEvent,
    plugin: ToolPlugin | undefined
  ): Promise<boolean> {
    const inputTokens = finiteTokenCount(session.lastInputTokens) ?? finiteTokenCount(session.lastTotalTokens);
    if (inputTokens === undefined || inputTokens <= 0) return false;
    if (!plugin) return false;
    try {
      const previewInput = tokenPressurePreviewInput(session);
      const preview = await plugin.execute({
        id: createId("token_pressure_preview"),
        toolName: "check_chat",
        input: previewInput,
        requester: event.source,
        session: event.session
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
        noteLLMSessionUpdated();
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
        noteLLMSessionUpdated();
      }
      return comparison.shouldReset;
    } catch {
      return false;
    }
  }

  function tokenPressurePreviewInput(session: ActiveLLMSession): { __preview: true; __scope: "today" | "from_prefix"; __fromPrefixAfterMessageId?: number } {
    if (session.mode === "fixed_prefix") {
      return {
        __preview: true,
        __scope: "from_prefix",
        __fromPrefixAfterMessageId: session.fixedPrefixCursorMessageId ?? 0
      };
    }
    return { __preview: true, __scope: "today" };
  }

  function tokenPressureBaselineKey(session: ActiveLLMSession, scope: "today" | "from_prefix"): string {
    return [
      session.lastUsageModel ?? deps.config.llm.model ?? "",
      session.mode || "normal",
      scope,
      scope === "from_prefix" ? String(session.fixedPrefixCursorMessageId ?? 0) : ""
    ].join("|");
  }

  function hydrateLLMSessionSnapshot(snapshot: LLMSessionSnapshot): ActiveLLMSession {
    const modeStaticMessages = cloneLLMMessages(snapshot.modeStaticMessages ?? []);
    const mode = snapshot.mode || "normal";
    const parsedModeStartedAt = typeof snapshot.modeStartedAt === "string" ? Date.parse(snapshot.modeStartedAt) : NaN;
    const parsedModeExpiresAt = typeof snapshot.modeExpiresAt === "string" ? Date.parse(snapshot.modeExpiresAt) : NaN;
    return {
      messages: cloneLLMMessages(snapshot.messages),
      staticPromptFingerprint: snapshot.staticPromptFingerprint ?? "",
      staticPromptMessageCount: typeof snapshot.staticPromptMessageCount === "number" && Number.isFinite(snapshot.staticPromptMessageCount)
        ? Math.max(0, Math.floor(snapshot.staticPromptMessageCount))
        : 0,
      requestTimestamps: (snapshot.requestTimestamps ?? [])
        .map((timestamp) => Date.parse(timestamp))
        .filter((timestamp) => Number.isFinite(timestamp)),
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
        : undefined,
      hydratedFixedPrefixPendingRebuild: mode === "fixed_prefix"
    };
  }

  function defaultModeState(): ModeState {
    return { mode: "normal", modeStaticMessages: [], modeStaticTokenEstimate: 0, tokenPressurePreviewBaselines: {} };
  }

  function modeStateFromSession(session: ActiveLLMSession): ModeState {
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

  function isModeExpired(session: ActiveLLMSession): boolean {
    if (session.mode !== "fixed_prefix") return false;
    if (!Number.isFinite(session.modeExpiresAt)) return false;
    return time.now().epochMs >= Number(session.modeExpiresAt);
  }

  function cloneLLMMessages(messages: LLMChatInput["messages"]): LLMChatInput["messages"] {
    return messages.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
    }));
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

  function noteLLMSessionUpdated(): void {
    if (!activeLLMSession) return;
    deps.onLLMSessionUpdated?.({
      messages: cloneLLMMessages(activeLLMSession.messages),
      staticPromptFingerprint: activeLLMSession.staticPromptFingerprint,
      staticPromptMessageCount: activeLLMSession.staticPromptMessageCount,
      requestTimestamps: activeLLMSession.requestTimestamps.map((timestamp) => new Date(timestamp).toISOString()),
      lastTotalTokens: activeLLMSession.lastTotalTokens,
      lastInputTokens: activeLLMSession.lastInputTokens,
      lastUsageModel: activeLLMSession.lastUsageModel,
      tokenPressurePreviewBaselines: cloneTokenPressurePreviewBaselines(activeLLMSession.tokenPressurePreviewBaselines),
      mode: activeLLMSession.mode,
      modeStaticMessages: cloneLLMMessages(activeLLMSession.modeStaticMessages),
      modeStaticTokenEstimate: activeLLMSession.modeStaticTokenEstimate,
      modeStartedAt: typeof activeLLMSession.modeStartedAt === "number" ? new Date(activeLLMSession.modeStartedAt).toISOString() : undefined,
      modeExpiresAt: typeof activeLLMSession.modeExpiresAt === "number" ? new Date(activeLLMSession.modeExpiresAt).toISOString() : undefined,
      fixedPrefixKind: activeLLMSession.fixedPrefixKind,
      fixedPrefixCursorMessageId: activeLLMSession.fixedPrefixCursorMessageId,
      waitChatStartedAt: typeof activeLLMSession.waitChatStartedAt === "number" ? new Date(activeLLMSession.waitChatStartedAt).toISOString() : undefined
    });
  }
}

function filterVisibleTools(tools: ToolPlugin[], profile: PromptProfile): ToolPlugin[] {
  return tools.filter((plugin) => {
    if (plugin.id === "messaging") return profile.visibleTools.feishu !== false;
    if (plugin.id === "photo") return profile.visibleTools.photo !== false && profile.visibleTools.media !== false;
    if (plugin.id === "shell") return profile.visibleTools.shell !== false;
    return true;
  });
}

function findToolPlugin(tools: ToolPlugin[], toolName: string): ToolPlugin | undefined {
  return tools.find((plugin) => plugin.listTools().some((tool) => tool.name === toolName));
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toolCallSignature(name: string, rawArguments: string): string {
  return `${name}:${stableJson(parseToolArguments(rawArguments))}`;
}

function reasoningContentForToolRequest(reasoningContent: string | undefined, toolCallCount: number): string | undefined {
  if (reasoningContent) return reasoningContent;
  return toolCallCount > 0 ? "Need to call the requested tool." : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatToolResultForLLM(result: ToolResult, variables: LLMTextVariables = {}): string {
  return renderToolResultForLLM(result, variables);
}

function toolResultText(result: ToolResult): string {
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined || result.output === null) return result.error ?? "";
  try {
    return JSON.stringify(result.output);
  } catch {
    return String(result.output);
  }
}

function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += /[\u4e00-\u9fff]/.test(char) ? 0.6 : 0.3;
  }
  return Math.round(tokens);
}

function estimateMessagesTokens(messages: LLMChatInput["messages"]): number {
  return estimateTextTokens(messages.map((message) => [
    message.role,
    message.content,
    message.reasoningContent ?? "",
    message.name ?? "",
    message.toolCallId ?? "",
    JSON.stringify(message.toolCalls ?? [])
  ].join("\n")).join("\n"));
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

function renderLLMTextValue(value: string, variables: LLMTextVariables): string {
  return String(renderLLMValue(value, variables));
}

function isRetryableLLMError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b/.test(message)
    || /service[_ ]unavailable|too busy|temporarily|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
}

function sleepCocoonGeneratedInstruction(event: AgentEvent, userName: string): string | undefined {
  const raw = event.meta.raw;
  if (!raw || typeof raw !== "object") return undefined;
  if ((raw as { sleepCocoonGoodnight?: unknown }).sleepCocoonGoodnight) {
    return `爱丽丝你困了，对${userName}说晚安，然后使用 sleep_cocoon({"action":"in"}) 去睡觉。`;
  }
  if ((raw as { sleepCocoonMorning?: unknown }).sleepCocoonMorning) {
    return `爱丽丝你醒了? 对${userName}说句早安吧`;
  }
  if ((raw as { sleepCocoonForceWake?: unknown }).sleepCocoonForceWake) {
    return `爱丽丝你被${userName}强制唤醒了。短短回应${userName}，语气带一点刚醒的迷糊，避免普通晨间问候。`;
  }
  return undefined;
}

function llmRetryDelayMs(attempt: number): number {
  return 1_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendStreamingLine(
  plugin: ToolPlugin,
  event: AgentEvent,
  callId: string,
  type: "message" | "voice",
  line: string,
  resultsByCallId: Map<string, ToolResult>
): Promise<void> {
  const previous = resultsByCallId.get(callId);
  const previousOutput = typeof previous?.output === "string" ? previous.output : "";
  try {
    const result = await plugin.execute({
      id: `${callId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      toolName: sendChatToolName,
      input: { type, content: line },
      requester: event.source,
      session: event.session
    });
    const output = formatToolResultForLLM(result);
    resultsByCallId.set(callId, {
      callId,
      ok: previous?.ok === false ? false : result.ok,
      output: mergeToolOutputs(previousOutput, output),
      error: previous?.error ?? result.error
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    resultsByCallId.set(callId, {
      callId,
      ok: false,
      output: previousOutput,
      error: previous?.error ?? reason
    });
  }
}

function isSendChatToolName(toolName: string | undefined): boolean {
  return toolName === sendChatToolName || toolName === "send_feishu" || toolName === "send_wechat" || toolName === "send_message";
}

function isWaitChatToolName(toolName: string | undefined): boolean {
  return toolName === "wait_chat";
}

function mergeToolOutputs(previousOutput: string, nextOutput: string): string {
  if (!previousOutput) return nextOutput;
  if (!nextOutput) return previousOutput;
  const previousChat = parseChatToolOutput(previousOutput);
  const nextChat = parseChatToolOutput(nextOutput);
  if (!previousChat || !nextChat) return [previousOutput, nextOutput].filter(Boolean).join("\n");
  return `<chat-log>\n${[previousChat.body, nextChat.body].filter(Boolean).join("\n")}\n</chat-log>\n<time>${nextChat.currentTime}<\\time>`;
}

function parseChatToolOutput(output: string): { body: string; currentTime: string } | undefined {
  const match = /^<chat-log>\n([\s\S]*)\n<\/chat-log>\n<time>([\s\S]*?)<\\time>$/.exec(output.trim());
  if (!match) return undefined;
  return { body: match[1], currentTime: match[2] };
}

class StreamingSendMessageState {
  callId?: string;
  toolName?: string;
  private argumentsText = "";
  private scanIndex = 0;
  private contentStarted = false;
  private contentDone = false;
  private escaped = false;
  private unicodeBuffer = "";
  private pendingLine = "";
  private heldStreamingLine: string | undefined;
  private readyLines: string[] = [];
  private pendingLines: string[] = [];
  private explicitStreamingType: "message" | "voice" | undefined;
  private sawNonStreamingType = false;

  accept(delta: LLMToolCallDelta): { readyLines: string[]; pendingLines: string[] } {
    if (delta.id) this.callId = delta.id;
    if (delta.function?.name) this.toolName = delta.function.name;
    if (delta.function?.arguments) {
      this.argumentsText += delta.function.arguments;
      this.updateTypeState();
      this.scan();
    }
    return {
      readyLines: this.drainReadyLines(),
      pendingLines: [...this.pendingLines]
    };
  }

  finish(): string[] {
    const lines = this.shouldSendAsStreamingType()
      ? [...this.pendingLines, ...this.stageStreamingLines(this.drainReadyLines())]
      : [];
    this.pendingLines = [];
    if (this.heldStreamingLine && this.shouldSendAsStreamingType()) lines.push(this.heldStreamingLine);
    this.heldStreamingLine = undefined;
    const tail = this.pendingLine.trim();
    if (tail && this.shouldSendAsStreamingType()) lines.push(tail);
    this.pendingLine = "";
    return lines;
  }

  canStreamNow(): boolean {
    return Boolean(this.explicitStreamingType) && !this.sawNonStreamingType;
  }

  shouldSendAsStreamingType(): boolean {
    return !this.sawNonStreamingType;
  }

  sendType(): "message" | "voice" {
    return this.explicitStreamingType ?? "message";
  }

  dropPendingLines(): void {
    this.pendingLines = [];
  }

  stageStreamingLines(lines: string[]): string[] {
    const ready: string[] = [];
    for (const line of lines) {
      if (this.heldStreamingLine) ready.push(this.heldStreamingLine);
      this.heldStreamingLine = line;
    }
    return ready;
  }

  hasUnsafeArguments(): boolean {
    return hasUnsafeSendChatArguments(this.argumentsText);
  }

  private updateTypeState(): void {
    const typeMatch = /"type"\s*:\s*"([^"]*)"/.exec(this.argumentsText);
    if (!typeMatch) return;
    this.explicitStreamingType = typeMatch[1] === "message" || typeMatch[1] === "voice" ? typeMatch[1] : undefined;
    this.sawNonStreamingType = !this.explicitStreamingType;
  }

  private scan(): void {
    if (!this.contentStarted) {
      const match = /"content"\s*:\s*"/.exec(this.argumentsText.slice(this.scanIndex));
      if (!match) return;
      this.scanIndex += match.index + match[0].length;
      this.contentStarted = true;
    }

    while (this.scanIndex < this.argumentsText.length && !this.contentDone) {
      const char = this.argumentsText[this.scanIndex];
      this.scanIndex += 1;
      if (this.unicodeBuffer) {
        this.unicodeBuffer += char;
        if (this.unicodeBuffer.length === 4) {
          this.pushDecoded(String.fromCharCode(Number.parseInt(this.unicodeBuffer, 16)));
          this.unicodeBuffer = "";
          this.escaped = false;
        }
        continue;
      }
      if (this.escaped) {
        if (char === "u") {
          this.unicodeBuffer = "";
          continue;
        }
        this.pushDecoded(decodeJsonEscape(char));
        this.escaped = false;
        continue;
      }
      if (char === "\\") {
        this.escaped = true;
        continue;
      }
      if (char === "\"") {
        this.contentDone = true;
        continue;
      }
      this.pushDecoded(char);
    }
  }

  private pushDecoded(char: string): void {
    if ((char === "n" || char === "r") && this.pendingLine.endsWith("\\")) {
      this.pendingLine = this.pendingLine.slice(0, -1);
      if (char === "r") return;
      this.pushDecoded("\n");
      return;
    }
    if (char === "\n") {
      const line = this.pendingLine.trim();
      if (line) {
        if (this.canStreamNow()) {
          this.readyLines.push(line);
        } else {
          this.pendingLines.push(line);
        }
      }
      this.pendingLine = "";
      return;
    }
    if (char !== "\r") this.pendingLine += char;
  }

  private drainReadyLines(): string[] {
    const lines = this.readyLines;
    this.readyLines = [];
    return lines;
  }

  restoreReadyLines(lines: string[]): void {
    this.readyLines = [...lines, ...this.readyLines];
  }
}

function decodeJsonEscape(char: string): string {
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";
  if (char === "b") return "\b";
  if (char === "f") return "\f";
  return char;
}

function hasUnsafeSendChatArguments(rawArguments: string): boolean {
  return containsDsmlMarkup(rawArguments) || countJsonContentKeys(rawArguments) > 1;
}

function containsDsmlMarkup(value: string): boolean {
  return /<\s*[｜|]{2}\s*DSML\s*[｜|]{2}/i.test(value);
}

function countJsonContentKeys(raw: string): number {
  return raw.match(/"content"\s*:/g)?.length ?? 0;
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
      sessionId: event.session.sessionId,
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
