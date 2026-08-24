import type { ToolCall, ToolExecutionContext, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { awaitChatWaitSeconds, clearYieldAlbertContent, finishAndWaitTool, maxYieldWaitSeconds, minYieldWaitSeconds } from "../profile.js";

export type FinishAndWaitActions = "schedule" | "clear" | "await_chat" | "finish";

export { clearYieldAlbertContent };

export function createFinishAndWaitTools(input?: {
  /** 复用 agent state 的 subAgent hold: >0 表示有 subagent 在运行。 */
  agentState?: { getSubAgentHoldCount(): number };
}): ToolPlugin {
  return {
    id: "finish-and-wait",
    listTools() {
      return [finishAndWaitTool];
    },
    async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      if (call.toolName !== finishAndWaitTool.name) {
        return { callId: call.id, ok: false, error: `Unknown finish-and-wait tool: ${call.toolName}` };
      }
      const error = validateYieldInput(call.input);
      if (error) return { callId: call.id, ok: false, error };
      const action = call.input.action as FinishAndWaitActions;
      if (action === "clear") {
        if (call.input.__preview === true) return { callId: call.id, ok: true };
        return {
          callId: call.id,
          ok: true,
          resetLLMSession: true,
          continueAfterReset: true,
          appendAlbertMessage: { contentText: clearYieldAlbertContent },
          llmSessionStaticMessages: [{
            role: "user",
            name: "Alert",
            content: clearYieldAlbertContent
          }]
        };
      }
      if (action === "finish") {
        return {
          callId: call.id,
          ok: true,
          invalidateLLMSession: true,
          llmSessionClearReason: "yield_end"
        };
      }
      if (action === "schedule") {
        // schedule 是等待后台任务(subagent/bash)的机制: 连续调用且当前没有
        // 任何 subagent 在运行, 说明模型在空转, 直接报错。bash 在 loop 内
        // 阻塞执行, 刚执行过 bash 时上一个已完成工具是 Bash, 不构成连续调用。
        const runningSubAgents = input?.agentState?.getSubAgentHoldCount() ?? 0;
        if (context?.lastCompletedToolName === finishAndWaitTool.name && runningSubAgents === 0) {
          return {
            callId: call.id,
            ok: false,
            error: "schedule_consecutive_without_running_task: 连续调用 schedule 且当前没有运行中的 subagent 后台任务, 不允许空转"
          };
        }
        return {
          callId: call.id,
          ok: true,
          meta: {
            yieldReturn: true,
            yieldAction: "schedule",
            yieldSeconds: typeof call.input.timer === "number" ? call.input.timer : undefined
          }
        };
      }
      return {
        callId: call.id,
        ok: true,
        meta: {
          yieldReturn: true,
          yieldAction: "await_chat",
          yieldSeconds: awaitChatWaitSeconds
        }
      };
    }
  };
}

function validateYieldInput(input: Record<string, unknown>): string | undefined {
  const keys = Object.keys(input).filter((key) => key !== "__preview");
  const action = input.action;
  if (action === "clear" || action === "finish" || action === "await_chat") {
    return keys.length === 1 ? undefined : `Yield ${action} only accepts action`;
  }
  if (action === "schedule") {
    if (keys.length !== 2 || !keys.includes("timer")) return "Yield schedule requires action and timer";
    if (!Number.isInteger(input.timer) || Number(input.timer) < minYieldWaitSeconds || Number(input.timer) > maxYieldWaitSeconds) {
      return `Yield seconds must be an integer from ${minYieldWaitSeconds} to ${maxYieldWaitSeconds}`;
    }
    return undefined;
  }
  return "Yield action must be schedule, clear, await_chat or finish";
}
