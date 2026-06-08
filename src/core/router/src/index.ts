import type { AgentEvent } from "../../../packages/types/src/index.js";

export type Intent =
  | { kind: "chat"; text: string }
  | { kind: "codex"; command: string; prompt: string }
  | { kind: "unsupported"; reason: string };

export interface IntentRouter {
  route(event: AgentEvent): Intent;
}

export function createIntentRouter(): IntentRouter {
  return {
    route(event) {
      if (event.payload.kind !== "text") {
        return { kind: "unsupported", reason: `payload ${event.payload.kind} is not implemented` };
      }

      const text = event.payload.text.trim();
      if (text.startsWith("/codex")) {
        return {
          kind: "codex",
          command: "/codex",
          prompt: text.slice("/codex".length).trim()
        };
      }

      return { kind: "chat", text };
    }
  };
}
