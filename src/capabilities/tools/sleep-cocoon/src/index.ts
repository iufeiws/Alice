import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/tool-execution/src/index.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import type { SystemNoticeStore } from "../../../../contexts/conversation-hub/src/application/message-runtime.js";
import { sleepCocoonTool, sleepCocoonToolText } from "../profile.js";

type SleepCocoonAgentState = {
  getSnapshot(): { state: string; sleepCocoonEnteredAt?: string; sleepCocoonEnteredAtUtc?: string; sleepCocoonAutoCheckedAt?: string };
  setState(state: string, options?: Record<string, unknown>): unknown;
};

export * from "./sleep-cocoon-math.js";
export * from "./sleep-cocoon-event-runtime.js";

export type SleepCocoonToolTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type SleepCocoonToolsDeps = {
  agentState: SleepCocoonAgentState;
  time: CurrentTimeProvider;
  store?: SystemNoticeStore;
  outputRouter?: Pick<OutputRouter, "send">;
  getDefaultTarget?(): SleepCocoonToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  random?: () => number;
};

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export function createSleepCocoonTools(deps: SleepCocoonToolsDeps): ToolPlugin {
  const random = deps.random ?? Math.random;

  return {
    id: "sleep_cocoon",
    listTools() {
      return [sleepCocoonTool];
    },
    async execute(call) {
      if (call.toolName !== "sleep_cocoon") return toolError(call, sleepCocoonToolText.unknownTool(call.toolName));
      const action = stringValue(call.input.action).trim();
      if (action === "in") return enterSleepCocoon(call);
      if (action === "out") return exitSleepCocoon(call);
      return toolError(call, sleepCocoonToolText.unsupportedAction);
    }
  };

  async function enterSleepCocoon(call: ToolCall): Promise<ToolResult> {
    if (deps.agentState.getSnapshot().state === "going_to_sleep") return toolError(call, sleepCocoonToolText.alreadyEntered);
    const sleepDurationMs = resolveSleepDurationMs(call.input.hours, random);
    const now = deps.time.now();
    deps.agentState.setState("going_to_sleep", {
      reason: "sleep_cocoon_in",
      sleepCocoonEnteredAt: now.iso,
      sleepCocoonEnteredAtUtc: now.date.toISOString(),
      sleepDurationMs,
      resetSleepCocoonAuto: true
    });
    return {
      callId: call.id,
      ok: true,
      resetLLMSession: true,
      fixedPrefixKind: "sleep_cocoon",
      fixedPrefixTtlMs: 2 * HOUR,
      output: sleepCocoonToolText.success
    };
  }

  async function exitSleepCocoon(call: ToolCall): Promise<ToolResult> {
    const current = deps.agentState.getSnapshot();
    if (current.state !== "going_to_sleep") {
      return toolError(call, current.state === "sleeping" ? sleepCocoonToolText.alreadySleeping : sleepCocoonToolText.noCountdownToCancel);
    }
    deps.agentState.setState("waiting", { reason: "sleep_cocoon_out", clearSleepCocoon: true });
    return {
      callId: call.id,
      ok: true,
      resetLLMSession: true,
      clearFixedPrefix: true,
      output: sleepCocoonToolText.success
    };
  }

  function resolveTarget(call: ToolCall): SleepCocoonToolTarget | undefined {
    const resolved = deps.resolveOutputTarget?.(call);
    if (resolved) return resolved;
    if (call.requester?.plugin && call.externalSession?.sessionId) {
      return {
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.externalSession.sessionId
      };
    }
    return deps.getDefaultTarget?.();
  }
}

export function resolveSleepDurationMs(hours: unknown, random: () => number = Math.random): number {
  const requestedHours = integerValue(hours);
  if (requestedHours !== undefined) {
    const jitterMs = Math.round((random() * 30 - 15) * MINUTE);
    return Math.max(1, requestedHours * HOUR + jitterMs);
  }
  return Math.round((6 * HOUR) + random() * (2 * HOUR));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 1 ? numeric : undefined;
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
