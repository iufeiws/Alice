import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import type { PromptProfile, PromptRenderContext } from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import type {
  AgentInitiatedBehaviorPlan,
  AgentInitiatedBehaviorPromptProfile
} from "../../../src/contexts/initiative/src/domain/initiated-behavior.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

export function tempPath(name: string, fileName: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

export function writeInitiatedBehaviorProfile(name: string, profile: AgentInitiatedBehaviorPromptProfile): string {
  const filePath = tempPath(name, "profile.json");
  fs.writeFileSync(filePath, JSON.stringify(profile));
  return filePath;
}

export function initiatedBehaviorPlan(promptProfilePath: string): AgentInitiatedBehaviorPlan {
  return {
    id: "custom",
    kind: "event",
    enabled: true,
    triggerEvent: "custom.event",
    steps: [{ kind: "llm_instruction", promptProfilePath }]
  };
}

export function visiblePromptProfile(visibleTools: PromptProfile["visibleTools"] = { feishu: true }): PromptProfile {
  return { visibleTools, layers: [], appendLayers: [] };
}

export function promptRenderContext(userName = "YY"): PromptRenderContext {
  const time = createCurrentTimeProvider("UTC");
  return {
    renderer: testPromptRuntime({ user: userName, timezone: time.timeZone }),
    event: textEvent(),
    time
  };
}

export function textEvent(raw?: Record<string, unknown>): AgentEvent {
  return {
    id: "evt",
    type: "message.text",
    source: { plugin: "test", userId: "user" },
    externalSession: { scope: "dm", sessionId: "session" },
    payload: { kind: "text", text: "hi" },
    meta: {
      receivedAt: "2026-06-06T00:00:00.000Z",
      ...(raw ? { raw } : {})
    }
  };
}
