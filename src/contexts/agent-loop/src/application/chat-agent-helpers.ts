import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { AgentEvent, AgentOutput, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import type { PromptProfile } from "../../../agent-profile/src/application/build-system-prompt.js";
import {
  isToolVisibleInPromptProfile,
  type AgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorRun
} from "../../../initiative/src/domain/initiated-behavior.js";
import {
  cloneLLMMessages,
  defaultChatAgentModeState,
  estimateMessagesTokens,
  findToolPlugin
} from "./run-chat-loop.js";

export async function executeAgentInitiatedBehaviorBackendSteps(
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

export function applyBackendToolSessionControlToActiveSession(
  session: {
    messages: LLMChatInput["messages"];
    staticPromptFingerprint: string;
    mode: string;
    modeStaticMessages: LLMChatInput["messages"];
    modeStaticTokenEstimate: number;
    modeStartedAt?: number;
    modeExpiresAt?: number;
    fixedPrefixKind?: string;
    fixedPrefixStartedAt?: string;
    loopStartedAt?: string;
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
    session.modeStartedAt = undefined;
    session.modeExpiresAt = undefined;
    session.fixedPrefixKind = undefined;
    session.fixedPrefixStartedAt = undefined;
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
  session.modeStartedAt = modeStartedAt;
  session.modeExpiresAt = mode === "fixed_prefix" && typeof modeStartedAt === "number" ? modeStartedAt + ttlMs : undefined;
  session.fixedPrefixKind = fixedPrefixKind;
  if (mode === "fixed_prefix" && !session.loopStartedAt) throw new Error("fixed_prefix_loop_started_at_missing");
  session.fixedPrefixStartedAt = mode === "fixed_prefix" ? session.loopStartedAt : undefined;
}

export function filterVisibleTools(tools: ToolPlugin[], profile: PromptProfile): ToolPlugin[] {
  return tools.filter((plugin) => {
    if (plugin.id === "messaging") return isToolVisibleInPromptProfile(profile, "messaging");
    if (plugin.id === "photo") return isToolVisibleInPromptProfile(profile, "photo");
    if (plugin.id === "shell") return isToolVisibleInPromptProfile(profile, "shell");
    return plugin.listTools().some((tool) => isToolVisibleInPromptProfile(profile, tool.name));
  });
}

export function failMissingLoopStartedAt(): never {
  throw new Error("llm_loop_started_at_missing");
}

export function buildReply(
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
