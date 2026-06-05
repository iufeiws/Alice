import type { AgentEvent } from "../../../packages/types/src/index.js";
import type { LLMChatInput } from "../../llm/src/index.js";

export type AgentInitiatedBehavior =
  | { kind: "sleep_goodnight" }
  | { kind: "sleep_morning" }
  | { kind: "sleep_force_wake" };

export function agentInitiatedBehaviorFromEvent(event: AgentEvent): AgentInitiatedBehavior | undefined {
  const raw = event.meta.raw;
  if (!raw || typeof raw !== "object") return undefined;
  if ((raw as { sleepCocoonGoodnight?: unknown }).sleepCocoonGoodnight) return { kind: "sleep_goodnight" };
  if ((raw as { sleepCocoonMorning?: unknown }).sleepCocoonMorning) return { kind: "sleep_morning" };
  if ((raw as { sleepCocoonForceWake?: unknown }).sleepCocoonForceWake) return { kind: "sleep_force_wake" };
  return undefined;
}

export function buildAgentInitiatedBehaviorMessages(
  behavior: AgentInitiatedBehavior | undefined,
  userName: string
): LLMChatInput["messages"] {
  if (!behavior) return [];
  const content = agentInitiatedBehaviorInstruction(behavior, userName);
  return content ? [{ role: "user", content }] : [];
}

function agentInitiatedBehaviorInstruction(behavior: AgentInitiatedBehavior, userName: string): string | undefined {
  if (behavior.kind === "sleep_goodnight") {
    return `爱丽丝你困了，对${userName}说晚安，然后使用 sleep_cocoon({"action":"in"}) 去睡觉。`;
  }
  if (behavior.kind === "sleep_morning") {
    return `爱丽丝你醒了? 对${userName}说句早安吧`;
  }
  if (behavior.kind === "sleep_force_wake") {
    return `爱丽丝你被${userName}强制唤醒了。短短回应${userName}，语气带一点刚醒的迷糊，避免普通晨间问候。`;
  }
  return undefined;
}
