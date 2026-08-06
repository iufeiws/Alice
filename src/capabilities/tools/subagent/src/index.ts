import type { ToolCall, ToolExecutionContext, ToolPlugin } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import type { PiWorkerRuntime } from "../../../../contexts/pi-worker/src/index.js";
import { subAgentTool } from "../profile.js";

export type SubAgentInput =
  | { action: "start"; message: string; timeoutSeconds?: number }
  | { action: "list" }
  | { action: "read"; sessionId: string; view?: "context" | "messages" | "tree" }
  | { action: "send"; sessionId: string; message: string; mode?: "prompt" | "steer" | "follow_up"; timeoutSeconds?: number }
  | { action: "status"; sessionId: string }
  | { action: "wait"; sessionId: string; timeoutSeconds?: number }
  | { action: "cancel"; sessionId: string }
  | { action: "fork"; sessionId: string; entryId?: string };

export function createSubAgentTool(input: { runtime: PiWorkerRuntime; resolveOutputTarget?: ToolOutputTargetResolver; agentState?: { acquireSubAgentHold(): unknown; releaseSubAgentHold(): unknown } }): ToolPlugin {
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
      if (value.action === "start") {
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
        return { callId: call.id, ok: true, output: invocation };
      }
      if (value.action === "list") return { callId: call.id, ok: true, output: await input.runtime.listSubAgents(context?.signal) };
      if (value.action === "read") return { callId: call.id, ok: true, output: await input.runtime.readSubAgent(value.sessionId, value.view, context?.signal) };
      if (value.action === "send") {
        const invocation = await input.runtime.sendSubAgent(value.sessionId, {
          message: value.message,
          mode: value.mode,
          timeoutSeconds: value.timeoutSeconds,
          messageTarget,
          signal: context?.signal
        });
        if (invocation.status === "queued" || invocation.status === "running") {
          activeInvocations.add(`${invocation.sessionId}:${invocation.invocationId}`);
          input.agentState?.acquireSubAgentHold();
        }
        return { callId: call.id, ok: true, output: invocation };
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

function parseInput(call: ToolCall): SubAgentInput {
  const input = call.input as Record<string, unknown>;
  const action = input.action;
  if (action === "start" && typeof input.message === "string" && input.message.trim()) {
    return { action, message: input.message, ...(typeof input.timeoutSeconds === "number" ? { timeoutSeconds: input.timeoutSeconds } : {}) };
  }
  if (action === "list") return { action };
  if (action === "read" && typeof input.sessionId === "string" && input.sessionId.trim()) {
    const view = input.view;
    return { action, sessionId: input.sessionId, ...(view === "context" || view === "messages" || view === "tree" ? { view } : {}) };
  }
  if (action === "send" && typeof input.sessionId === "string" && input.sessionId.trim() && typeof input.message === "string" && input.message.trim()) {
    const mode = input.mode;
    return {
      action,
      sessionId: input.sessionId,
      message: input.message,
      ...(mode === "steer" || mode === "follow_up" || mode === "prompt" ? { mode } : {}),
      ...(typeof input.timeoutSeconds === "number" ? { timeoutSeconds: input.timeoutSeconds } : {})
    };
  }
  if (action === "status" && typeof input.sessionId === "string" && input.sessionId.trim()) return { action, sessionId: input.sessionId };
  if (action === "wait" && typeof input.sessionId === "string" && input.sessionId.trim()) {
    return { action, sessionId: input.sessionId, ...(typeof input.timeoutSeconds === "number" ? { timeoutSeconds: input.timeoutSeconds } : {}) };
  }
  if (action === "cancel" && typeof input.sessionId === "string" && input.sessionId.trim()) return { action, sessionId: input.sessionId };
  if (action === "fork" && typeof input.sessionId === "string" && input.sessionId.trim()) {
    return { action, sessionId: input.sessionId, ...(typeof input.entryId === "string" && input.entryId.trim() ? { entryId: input.entryId } : {}) };
  }
  throw new Error("invalid_subagent_input");
}
