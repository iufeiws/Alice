import { createChatAgent as createChatAgentUnderTest, type ChatAgentDeps } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
import type { LLMChatInput } from "../../../src/contexts/llm-gateway/src/index.js";
import { createLLMRequests } from "../../../src/contexts/llm-gateway/src/llm-requests.js";
import { registerLLMToolLoopTools } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { AgentEvent, AgentOutput, ToolCall } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import type { PromptProfile } from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import type { AgentStateStore } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type TestChatAgentDeps = Omit<ChatAgentDeps, "llmRequestSender" | "getPromptRenderer"> & Partial<Pick<ChatAgentDeps, "llmRequestSender" | "getPromptRenderer">>;

export function createChatAgent(deps: TestChatAgentDeps) {
  registerLLMToolLoopTools("default", deps.tools ?? []);
  let persistedSession = deps.initialLLMSession;
  const loadLLMSession = deps.loadLLMSession ?? (() => persistedSession);
  const onLLMSessionUpdated = deps.onLLMSessionUpdated;
  const onLLMSessionCleared = deps.onLLMSessionCleared;
  const getPromptProfile = deps.getPromptProfile ?? testPromptProfile;
  const requestLogs = new WeakMap<object, any>();
  const llmRequestSender = deps.llmRequestSender ?? createLLMRequests({
    getTool(name) {
      for (const plugin of deps.tools ?? []) {
        const tool = plugin.listTools().find((entry) => entry.name === name);
        if (tool) return tool;
      }
      return undefined;
    },
    onRequestPrepared(input, request) {
      const entry = deps.onLLMRequestPrepared?.(request);
      if (entry) requestLogs.set(input, entry);
    },
    onResponseReceived(input, _request, result) {
      deps.onLLMResponseReceived?.(result, requestLogs.get(input));
    },
    onLog(event) {
      deps.onLLMLog?.({ ...event, round: event.round });
    }
  }).send;
  return createChatAgentUnderTest({
    getPromptProfile: testPromptProfile,
    ...deps,
    getPromptRenderer: deps.getPromptRenderer ?? (() => {
      const time = (deps.time ?? createCurrentTimeProvider("UTC")).now();
      return testPromptRuntime({
        user: (deps.config as any).project?.username ?? "user",
        date_time: time.iso.slice(0, 19).replace("T", " "),
        time: time.iso.slice(11, 19),
        date: time.iso.slice(0, 10),
        timezone: time.timeZone
      });
    }),
    llmRequestSender,
    loadLLMSession,
    onLLMSessionUpdated(session) {
      if (!deps.loadLLMSession) persistedSession = session;
      onLLMSessionUpdated?.(session);
    },
    onLLMSessionCleared(reason) {
      if (!deps.loadLLMSession) persistedSession = undefined;
      onLLMSessionCleared?.(reason);
    }
  });
}

export type TestChatAgent = ReturnType<typeof createChatAgent>;

export function testPromptProfile(): PromptProfile {
  const profile = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "contexts", "agent-profile", "prompts", "prompt-profile.json"), "utf8")) as PromptProfile;
  return {
    ...profile,
    layers: profile.layers.filter((layer) => layer.role !== "tool_request"),
    appendLayers: (profile.appendLayers ?? []).filter((layer) => layer.role !== "tool_request")
  };
}

export async function runPreparedChatEvent(core: TestChatAgent, event: AgentEvent): Promise<AgentOutput[]> {
  const prepared = await core.prepareEventRun(event);
  if (Array.isArray(prepared)) return prepared;
  try {
    const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
    if (!spec) return [];
    if (Array.isArray(spec)) return spec;
    return await Promise.resolve(prepared.complete(await runAgentFunctionCallLoop(spec))) ?? [];
  } catch (error) {
    await prepared.onError?.(error);
    throw error;
  } finally {
    await prepared.dispose?.();
  }
}

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
    payload: { kind: "text", text: "what happened today?" },
    meta: {
      receivedAt: "2026-05-26T00:00:00.000Z",
      replyTo: "om_1"
    }
  };
}

export function chatTestTools(onCall?: (call: ToolCall) => void) {
  return {
    id: "messaging",
    listTools() {
      return [
        { name: "Chat", description: "view", inputSchema: { type: "object" } },
        { name: "Yield", description: "wait", inputSchema: { type: "object" } },
        { name: "later_tool", description: "later", inputSchema: { type: "object" } }
      ];
    },
    async execute(call: ToolCall) {
      onCall?.(call);
      if (call.toolName === "Yield") {
        return {
          callId: call.id,
          ok: true,
          meta: { yieldReturn: true }
        };
      }
      if (call.toolName === "Chat") {
        return {
          callId: call.id,
          ok: true,
          output: "<chat-log>\nnew chat\n</chat-log>\n<now local=\"2026-05-26T00:05:00.000\"/>"
        };
      }
      if (call.toolName === "later_tool") {
        return { callId: call.id, ok: true, output: "later" };
      }
      return { callId: call.id, ok: false, error: `unknown tool ${call.toolName}` };
    }
  };
}

export function memoryStore(initial?: string): AgentStateStore & { content?: string } {
  return {
    content: initial,
    read() {
      return this.content;
    },
    write(content) {
      this.content = content;
    }
  };
}

export function messageContentText(content: LLMChatInput["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
}
