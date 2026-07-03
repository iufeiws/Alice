import type { LLMMessageContent } from "../../../src/contexts/llm-gateway/src/index.js";
import { createLLMTextVariableRenderer, buildLLMTextVariables } from "../../../src/contexts/agent-profile/src/application/llm-text-renderer.js";
import type { PromptRenderContext } from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import type { DailyShellStore, ShellCategory, ShellOption } from "../../../src/contexts/agent-profile/src/domain/shell.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

export function textEvent(): AgentEvent {
  return {
    id: "evt_1",
    source: {
      plugin: "feishu",
      channelId: "chat-1",
      userId: "user-1",
      rawMessageId: "om_1"
    },
    externalSession: {
      scope: "dm",
      sessionId: "session-1"
    },
    type: "message.text",
    payload: { kind: "text", text: "hello" },
    meta: {
      receivedAt: "2026-05-26T00:00:00.000Z"
    }
  };
}

export function promptContext(input: {
  time?: ReturnType<typeof createCurrentTimeProvider>;
  memory?: {
    persistent?: string;
    userPreferences?: string;
    yesterdaySummary?: string;
  };
} = {}): PromptRenderContext {
  const time = input.time ?? createCurrentTimeProvider("UTC");
  return {
    renderer: createLLMTextVariableRenderer({
      variables: () => buildLLMTextVariables({
        userName: "小王",
        time,
        memory: input.memory
      })
    }),
    event: textEvent(),
    time
  };
}

export function replaceShellCategory(root: string, store: DailyShellStore, category: ShellCategory, options: ShellOption[]): void {
  const dir = path.join(root, "shell", category);
  if (fs.existsSync(dir)) {
    for (const fileName of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, fileName));
    }
  }
  for (const option of options) {
    store.saveOption(category, option);
  }
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function messageContentText(content: LLMMessageContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
}
