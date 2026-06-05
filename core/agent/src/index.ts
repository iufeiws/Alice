import type { AppConfig } from "../../../packages/config/src/index.js";
import type { LLMChatInput, LLMChatResult, LLMClient } from "../../llm/src/index.js";
import type { OutputRouter } from "../../output-router/src/index.js";
import type { PolicyEngine } from "../../policy/src/index.js";
import type { IntentRouter } from "../../router/src/index.js";
import type { SessionResolver } from "../../session/src/index.js";
import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../time/src/index.js";
import type { AgentEvent, AgentOutput, ChannelPlugin, ToolPlugin } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import { buildAppendPromptMessagesWithToolResults, buildPromptMessagesWithToolResults, defaultPromptProfile, staticPromptFingerprint, type PromptProfile } from "./prompts.js";
import type { AgentStateController, AgentStateSnapshot } from "./state.js";
import type { DailyShell } from "./shells.js";
import type { MemorySnapshot } from "./memory.js";
import { buildLLMTextVariables, type LLMTextVariables, type LLMTextWakeBoundary } from "../../text-renderer/src/index.js";
import { deepSeekPriceForModel } from "../../../packages/config/src/token-pricing.js";
import type { LLMRequestSender } from "./llm-tool-loop.js";
import {
  agentInitiatedBehaviorFromEvent,
  buildAgentInitiatedBehaviorMessages
} from "./initiated-behaviors.js";
import {
  buildFixedPrefixAppendMessages,
  buildWaitChatResumeMessages,
  checkChatCursorFromResult,
  cloneLLMMessages,
  defaultChatAgentModeState,
  estimateMessagesTokens,
  estimateTextTokens,
  findToolPlugin,
  runChatAgentLoop,
  runPromptToolRequest,
  toolResultText,
  type ChatAgentLoopInput,
  type ChatAgentLoopSession,
  type ChatAgentModeState
} from "./chat-loop.js";

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

type ModeState = ChatAgentModeState;

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
  getWakeBoundary?: () => LLMTextWakeBoundary | undefined;
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
  type ActiveLLMSession = ChatAgentLoopSession & {
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
      let initiatedBehavior = agentInitiatedBehaviorFromEvent(event);
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
        memory: deps.getMemorySnapshot?.(),
        wakeBoundary: deps.getWakeBoundary?.()
      });
      const ensureActiveLLMSession = async (): Promise<ActiveLLMSession> => {
        const promptContext = makePromptContext();
        const fingerprint = staticPromptFingerprint(promptProfile, promptContext);
        if (initiatedBehavior && activeLLMSession && !applyModeStateToNewSession) {
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
              ...buildAgentInitiatedBehaviorMessages(initiatedBehavior, promptProfile.userName),
              ...mode.modeStaticMessages
            ];
          initiatedBehavior = undefined;
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
          const waitChatResumeMessages = await buildWaitChatResumeMessages({
            session,
            event,
            toolPlugins,
            time,
            buildTextVariables: buildTurnTextVariables,
            onLLMLog: deps.onLLMLog
          });
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
            const appendMessages = await buildFixedPrefixAppendMessages({
              mode: modeStateFromSession(session),
              event,
              toolPlugins,
              nextToolCallId: () => `append_fixed_prefix_check_chat_${nextAppendToolCallId++}`,
              buildTextVariables: buildTurnTextVariables
            });
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
        const llmInput: ChatAgentLoopInput["llmInput"] = {
          messages: activeLLMSession.messages,
          client: llmConfig.client,
          model: llmConfig.model,
          temperature: llmConfig.temperature,
          extraParams: llmConfig.extraParams,
          followupExtraParams: llmConfig.followupExtraParams,
          stream: llmConfig.stream,
          toolNames: toolPlugins.flatMap((plugin) => plugin.listTools().map((tool) => tool.name))
        };
        const llmResult = await runChatAgentLoop({
          llmInput,
          event,
          toolPlugins,
          session: activeLLMSession,
          ensureSession: ensureActiveLLMSession,
          appendSessionContext,
          llm: deps.llm,
          llmRequestSender: deps.llmRequestSender,
          time,
          buildTextVariables: buildTurnTextVariables,
          noteSessionUpdated: noteLLMSessionUpdated,
          getLastCompletedToolName: () => lastCompletedToolName,
          setLastCompletedToolName(name) {
            lastCompletedToolName = name;
          },
          applyModeStateToNewSession(mode) {
            applyModeStateToNewSession = mode;
            activeLLMSession = undefined;
          },
          onSessionRebuilt: deps.onLLMSessionRebuilt,
          isLLMRunCancelled: deps.isLLMRunCancelled,
          onLLMRequestPrepared: deps.onLLMRequestPrepared,
          onLLMResponseReceived: deps.onLLMResponseReceived,
          onLLMLog: deps.onLLMLog
        });
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

  function buildTurnTextVariables(event: AgentEvent): LLMTextVariables {
    return buildLLMTextVariables({
      userName: (deps.getPromptProfile?.() ?? defaultPromptProfile()).userName,
      time,
      event,
      dailyShell: deps.getDailyShell?.(),
      dailyShellRaw: deps.getDailyShellRaw?.(),
      appearanceDescription: deps.getAppearanceDescription?.(),
      memory: deps.getMemorySnapshot?.(),
      wakeBoundary: deps.getWakeBoundary?.()
    });
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
    return defaultChatAgentModeState();
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
