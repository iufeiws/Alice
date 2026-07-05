import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

export const emptyPromptRenderer = () => testPromptRuntime();

export function fakeTime() {
  return {
    timeZone: "UTC",
    now: () => ({ date: new Date("2026-06-12T00:00:00.000Z"), iso: "2026-06-12T00:00:00.000", epochMs: 1, timeZone: "UTC" }),
    addMs: () => ({ date: new Date("2026-06-12T00:00:00.000Z"), iso: "2026-06-12T00:00:00.000", epochMs: 1, timeZone: "UTC" })
  };
}

export function textEvent(sessionId: string): AgentEvent {
  return {
    id: "evt_1",
    type: "message.text",
    source: { plugin: "test", userId: "user-1" },
    externalSession: { scope: "dm", sessionId },
    payload: { kind: "text", text: "hello" },
    meta: { receivedAt: "2026-06-12T00:00:00.000Z" }
  };
}
