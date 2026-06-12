import type { ToolCall } from "../../agent-loop/src/contracts/agent-contracts.js";

export type ToolOutputTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type ToolOutputTargetResolver = (call: ToolCall) => ToolOutputTarget | undefined;

export function createToolOutputTargetResolver(input: {
  getDefaultTarget?(): ToolOutputTarget | undefined;
  nonMessageRequesterPlugins?: readonly string[];
}): ToolOutputTargetResolver {
  const nonMessageRequesterPlugins = new Set(input.nonMessageRequesterPlugins ?? ["webrtc_voice"]);

  return (call) => {
    if (call.requester?.plugin && call.session?.sessionId && !nonMessageRequesterPlugins.has(call.requester.plugin)) {
      return normalizeToolOutputTarget({
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.session.sessionId
      });
    }
    const target = input.getDefaultTarget?.();
    return target ? normalizeToolOutputTarget(target) : undefined;
  };
}

export function normalizeToolOutputTarget(target: ToolOutputTarget): ToolOutputTarget {
  return {
    plugin: target.plugin,
    accountId: target.accountId,
    channelId: target.channelId,
    userId: target.userId,
    sessionId: target.sessionId
  };
}
