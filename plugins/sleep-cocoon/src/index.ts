import type { AgentStateController } from "../../../core/agent/src/state.js";
import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import type { ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../packages/types/src/index.js";

export type SleepCocoonToolsDeps = {
  agentState: Pick<AgentStateController, "getSnapshot" | "setState">;
  time: CurrentTimeProvider;
  random?: () => number;
};

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const sleepCocoonTool: ToolDefinition = {
  name: "sleep_cocoon",
  description: "睡眠茧。action=in 表示钻进睡眠茧准备入睡；action=out 表示在睡着前出来并撤销入睡倒计时。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["in", "out"] },
      hours: {
        type: "integer",
        minimum: 1,
        description: "可选睡眠小时数；实际睡眠会加入前后十五分钟随机浮动。"
      }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export function createSleepCocoonTools(deps: SleepCocoonToolsDeps): ToolPlugin {
  const random = deps.random ?? Math.random;

  return {
    id: "sleep_cocoon",
    listTools() {
      return [sleepCocoonTool];
    },
    async execute(call) {
      if (call.toolName !== "sleep_cocoon") return toolError(call, `Unknown sleep_cocoon tool: ${call.toolName}`);
      const action = stringValue(call.input.action).trim();
      if (action === "in") return enterSleepCocoon(call);
      if (action === "out") return exitSleepCocoon(call);
      return toolError(call, "unsupported action");
    }
  };

  function enterSleepCocoon(call: ToolCall): ToolResult {
    const sleepDurationMs = resolveSleepDurationMs(call.input.hours, random);
    const state = deps.agentState.setState("going_to_sleep", {
      reason: "sleep_cocoon_in",
      sleepCocoonEnteredAt: deps.time.now().iso,
      sleepDurationMs,
      resetSleepCocoonAuto: true
    });
    return {
      callId: call.id,
      ok: true,
      resetLLMSession: true,
      fixedPrefixKind: "sleep_cocoon",
      fixedPrefixTtlMs: 2 * HOUR,
      output: {
        action: "in",
        message: "已进入睡眠茧，开始入睡倒计时。",
        sleepDurationMs,
        state
      }
    };
  }

  function exitSleepCocoon(call: ToolCall): ToolResult {
    const current = deps.agentState.getSnapshot();
    if (current.state !== "going_to_sleep") {
      return toolError(call, current.state === "sleeping" ? "already sleeping" : "no sleep cocoon countdown to cancel");
    }
    const state = deps.agentState.setState("waiting", { reason: "sleep_cocoon_out", clearSleepCocoon: true });
    return {
      callId: call.id,
      ok: true,
      resetLLMSession: true,
      clearFixedPrefix: true,
      invalidateLLMSession: true,
      output: {
        action: "out",
        message: "已从睡眠茧出来，撤销入睡倒计时。",
        state
      }
    };
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
