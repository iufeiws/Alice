import type { ToolCall, ToolExecutionContext, ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import type { PiWorkerRuntime } from "../../../../contexts/pi-worker/src/index.js";
import { subAgentTool } from "../profile.js";

export type SubAgentInput =
  | { action: "spawn"; message: string; timeoutSeconds?: number }
  | { action: "messages"; sessionId: string; access: string }
  | { action: "send"; sessionId: string; message: string; timeoutSeconds?: number }
  | { action: "status"; sessionId: string }
  | { action: "wait"; sessionId: string; timeoutSeconds?: number }
  | { action: "cancel"; sessionId: string }
  | { action: "fork"; sessionId: string; entryId?: string };

// Future plan only: `list` may gain its own input and dispatch branch later.
// It is intentionally absent from the public union and cannot be called now.

export function createSubAgentTool(input: {
  runtime: PiWorkerRuntime;
  resolveOutputTarget?: ToolOutputTargetResolver;
  agentState?: { acquireSubAgentHold(): unknown; releaseSubAgentHold(): unknown };
  /**
   * 返回已注册的真实消息渠道 id 列表。Pi 调用必须携带真实渠道消息目标，
   * 非真实渠道（如 web-admin）或无目标只用于连通性验证的场景一律拒绝。
   */
  getRegisteredMessageChannels?(): readonly string[];
}): ToolPlugin {
  // Holds pair one-for-one with running invocations: a session with several
  // invocations (send while running, steer/follow_up) releases only when every
  // invocation has completed, so the Agent never stays locked in waiting.
  const activeInvocations = new Set<string>();
  input.runtime.onInvocationCompleted((completion) => {
    if (!activeInvocations.delete(`${completion.sessionId}:${completion.invocationId}`)) return;
    input.agentState?.releaseSubAgentHold();
  });
  return {
    id: "subagent",
    listTools() {
      return [subAgentTool];
    },
    async execute(call, context) {
      const value = parseInput(call);
      const messageTarget = messageTargetFromCall(call, input.resolveOutputTarget);
      if (value.action === "spawn" || value.action === "send") {
        const targetError = validateMessageTarget(messageTarget, input.getRegisteredMessageChannels);
        if (targetError) return { callId: call.id, ok: false, error: targetError };
      }
      if (value.action === "spawn") {
        const invocation = await input.runtime.startSubAgent({
          message: value.message,
          timeoutSeconds: value.timeoutSeconds,
          messageTarget,
          signal: context?.signal
        });
        if (invocation.status === "queued" || invocation.status === "running") {
          activeInvocations.add(`${invocation.sessionId}:${invocation.invocationId}`);
          input.agentState?.acquireSubAgentHold();
        }
        return { callId: call.id, ok: true, output: { sessionId: invocation.sessionId } };
      }
      if (value.action === "messages") return { callId: call.id, ok: true, output: await input.runtime.messagesSubAgent(value.sessionId, value.access, context?.signal) };
      if (value.action === "send") {
        const invocation = await input.runtime.sendSubAgent(value.sessionId, {
          message: value.message,
          timeoutSeconds: value.timeoutSeconds,
          messageTarget,
          signal: context?.signal
        });
        if (invocation.status === "queued" || invocation.status === "running") {
          activeInvocations.add(`${invocation.sessionId}:${invocation.invocationId}`);
          input.agentState?.acquireSubAgentHold();
        }
        return { callId: call.id, ok: true, output: { sessionId: invocation.sessionId } };
      }
      if (value.action === "status") return { callId: call.id, ok: true, output: await input.runtime.statusSubAgent(value.sessionId, context?.signal) };
      if (value.action === "wait") return { callId: call.id, ok: true, output: await input.runtime.waitSubAgent(value.sessionId, value.timeoutSeconds, context?.signal) };
      if (value.action === "cancel") return { callId: call.id, ok: true, output: await input.runtime.cancelSubAgent(value.sessionId, context?.signal) };
      return { callId: call.id, ok: true, output: await input.runtime.forkSubAgent(value.sessionId, value.entryId, context?.signal) };
    }
  };
}

function messageTargetFromCall(call: ToolCall, resolveOutputTarget?: ToolOutputTargetResolver): Record<string, unknown> | undefined {
  const resolved = resolveOutputTarget?.(call);
  if (resolved) {
    return {
      scope: call.externalSession?.scope,
      plugin: resolved.plugin,
      accountId: resolved.accountId,
      channelId: resolved.channelId,
      userId: resolved.userId,
      sessionId: resolved.sessionId
    };
  }
  const session = call.externalSession;
  if (!session || typeof session.sessionId !== "string" || !session.sessionId) return undefined;
  return {
    scope: session.scope,
    sessionId: session.sessionId,
    plugin: call.requester?.plugin,
    accountId: call.requester?.accountId,
    channelId: call.requester?.channelId,
    userId: call.requester?.userId
  };
}

/** 未注入注册渠道时回退到当前已注册的真实消息渠道（飞书/微信）。 */
const FALLBACK_REGISTERED_MESSAGE_CHANNELS = ["feishu", "wechat"] as const;

/**
 * Pi 调用必须携带真实渠道消息目标，否则显式报错。无目标的 Pi 调用只可能是
 * 连通性验证，这种验证应走 previewPrompt，而不是发起一次没有投递目标的调用。
 */
function validateMessageTarget(messageTarget: Record<string, unknown> | undefined, getRegisteredMessageChannels?: () => readonly string[]): string | undefined {
  if (!messageTarget) {
    return "pi_invocation_requires_message_target: Pi 调用必须携带真实渠道消息目标，连通性验证请使用 previewPrompt";
  }
  const plugin = typeof messageTarget.plugin === "string" && messageTarget.plugin ? messageTarget.plugin : undefined;
  if (!plugin) {
    return "pi_invocation_requires_message_target: 缺少目标渠道 plugin";
  }
  const registered = getRegisteredMessageChannels?.() ?? FALLBACK_REGISTERED_MESSAGE_CHANNELS;
  if (!registered.includes(plugin)) {
    return `pi_invocation_unsupported_target_plugin: 目标渠道 ${plugin} 不是已注册的真实消息渠道（当前注册：${registered.join("/")}）`;
  }
  return undefined;
}

function parseInput(call: ToolCall): SubAgentInput {
  const input = call.input as Record<string, unknown>;
  const action = input.action;
  if (action === "spawn" && onlyKeys(input, ["action", "message", "timeoutSeconds"]) && typeof input.message === "string" && input.message.trim() && validTimeout(input.timeoutSeconds)) {
    return { action, message: input.message, ...(typeof input.timeoutSeconds === "number" ? { timeoutSeconds: input.timeoutSeconds } : {}) };
  }
  if (action === "messages" && onlyKeys(input, ["action", "sessionId", "access"]) && typeof input.sessionId === "string" && input.sessionId.trim() && typeof input.access === "string" && input.access.trim()) {
    return { action, sessionId: input.sessionId, access: input.access };
  }
  if (action === "send" && onlyKeys(input, ["action", "sessionId", "message", "timeoutSeconds"]) && typeof input.sessionId === "string" && input.sessionId.trim() && typeof input.message === "string" && input.message.trim() && validTimeout(input.timeoutSeconds)) {
    return {
      action,
      sessionId: input.sessionId,
      message: input.message,
      ...(typeof input.timeoutSeconds === "number" ? { timeoutSeconds: input.timeoutSeconds } : {})
    };
  }
  if (action === "status" && onlyKeys(input, ["action", "sessionId"]) && typeof input.sessionId === "string" && input.sessionId.trim()) return { action, sessionId: input.sessionId };
  if (action === "wait" && onlyKeys(input, ["action", "sessionId", "timeoutSeconds"]) && typeof input.sessionId === "string" && input.sessionId.trim() && validTimeout(input.timeoutSeconds)) {
    return { action, sessionId: input.sessionId, ...(typeof input.timeoutSeconds === "number" ? { timeoutSeconds: input.timeoutSeconds } : {}) };
  }
  if (action === "cancel" && onlyKeys(input, ["action", "sessionId"]) && typeof input.sessionId === "string" && input.sessionId.trim()) return { action, sessionId: input.sessionId };
  if (action === "fork" && onlyKeys(input, ["action", "sessionId", "entryId"]) && typeof input.sessionId === "string" && input.sessionId.trim() && (input.entryId === undefined || typeof input.entryId === "string" && input.entryId.trim())) {
    return { action, sessionId: input.sessionId, ...(typeof input.entryId === "string" ? { entryId: input.entryId } : {}) };
  }
  throw new Error("invalid_subagent_input");
}

function onlyKeys(input: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function validTimeout(value: unknown): boolean {
  return value === undefined || typeof value === "number" && Number.isFinite(value) && value > 0;
}
