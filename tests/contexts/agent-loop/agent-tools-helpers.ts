import { createChatAgent as createChatAgentUnderTest, type ChatAgentDeps } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
import type { LLMChatInput } from "../../../src/contexts/llm-gateway/src/index.js";
import { createLLMRequests } from "../../../src/contexts/llm-gateway/src/llm-requests.js";
import { registerToolPlugins } from "../../../src/contexts/tool-execution/src/index.js";
import type { AgentEvent, AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolCall } from "../../../src/contexts/tool-execution/src/index.js";
import type { PromptProfile } from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import type { AgentStateStore } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import type { SessionClearResult } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import { runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type TestChatAgentDeps = Omit<ChatAgentDeps, "llmRequestSender" | "getPromptRenderer" | "getPromptProfile" | "createLLMSessionId" | "onLLMSessionCleared" | "onLLMSessionRebuilt"> & Partial<Pick<ChatAgentDeps, "llmRequestSender" | "getPromptRenderer" | "createLLMSessionId">> & {
  getPromptProfile?: () => PromptProfile | Record<string, any>;
  onLLMSessionCleared?: (reason: Parameters<ChatAgentDeps["onLLMSessionCleared"]>[0]) => void | SessionClearResult | Promise<void | SessionClearResult>;
  onLLMSessionRebuilt?: () => void | SessionClearResult | Promise<void | SessionClearResult>;
};

export function createChatAgent(deps: TestChatAgentDeps) {
  registerToolPlugins("default", deps.tools ?? []);
  let persistedSession = deps.initialLLMSession;
  const loadLLMSession = deps.loadLLMSession ?? (() => persistedSession);
  const onLLMSessionUpdated = deps.onLLMSessionUpdated;
  const onLLMSessionCleared = deps.onLLMSessionCleared;
  const onLLMSessionRebuilt = deps.onLLMSessionRebuilt;
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
    ...deps,
    createLLMSessionId: deps.createLLMSessionId ?? (() => (deps.time ?? createCurrentTimeProvider("UTC")).now().epochMs),
    getPromptProfile: () => normalizeTestPromptProfile(getPromptProfile()),
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
    async onLLMSessionCleared(reason) {
      const result = await onLLMSessionCleared?.(reason);
      const normalizedResult = result ?? { cleared: true, shortMemoryCaptured: false };
      if (!deps.loadLLMSession && normalizedResult.cleared) persistedSession = undefined;
      return normalizedResult;
    },
    async onLLMSessionRebuilt() {
      return await onLLMSessionRebuilt?.() ?? { cleared: true, shortMemoryCaptured: false };
    }
  });
}

export type TestChatAgent = ReturnType<typeof createChatAgent>;

export function testPromptProfile(): PromptProfile {
  const profile = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "contexts", "agent-profile", "prompts", "prompt-profile.json"), "utf8")) as PromptProfile;
  return {
    ...profile,
    layers: { ...profile.layers, messages: profile.layers.messages.filter((message) => !message.toolCalls?.length) },
    appendLayers: { ...profile.appendLayers!, messages: profile.appendLayers!.messages.filter((message) => !message.toolCalls?.length) }
  };
}

function normalizeTestPromptProfile(profile: PromptProfile | Record<string, any>): PromptProfile {
  if (!Array.isArray(profile.layers)) return profile as PromptProfile;
  const convert = (items: any[] = [], prefix: string) => ({
    meta: {},
    messages: items.sort((left, right) => (left.order ?? 0) - (right.order ?? 0)).map((item, itemIndex) => ({
      meta: { title: item.title ?? `Message ${itemIndex + 1}`, enabled: item.enabled !== false },
      role: item.role === "tool_request" ? "assistant" : item.role,
      content: item.content ?? "",
      ...(item.name ? { name: item.name } : {}),
      ...((item.thinking !== undefined || item.role === "tool_request") ? { reasoningContent: item.thinking ?? item.content ?? "" } : {}),
      ...(Array.isArray(item.toolCalls) ? {
        toolCalls: item.toolCalls.map((call: any, callIndex: number) => ({
          id: call.toolCallId ?? `${prefix}_${item.id ?? itemIndex + 1}_${callIndex + 1}`,
          type: "function",
          function: { name: call.toolName, arguments: call.toolArguments }
        }))
      } : {})
    }))
  });
  return {
    visibleTools: profile.visibleTools ?? { feishu: true },
    layers: convert(profile.layers, "prompt"),
    appendLayers: convert(profile.appendLayers, "append"),
    interruptLayer: profile.interruptLayer && !Array.isArray(profile.interruptLayer.messages)
      ? convert([profile.interruptLayer], "interrupt")
      : profile.interruptLayer ?? { meta: {}, messages: [] }
  };
}

export async function runPreparedChatEvent(
  core: TestChatAgent,
  event: AgentEvent,
  options?: Parameters<TestChatAgent["prepareEventRun"]>[1]
): Promise<AgentOutput[]> {
  const prepared = await core.prepareEventRun(event, options);
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
        if (call.input.action === "finish") {
          return {
            callId: call.id,
            ok: true,
            invalidateLLMSession: true,
            llmSessionClearReason: "yield_end" as const
          };
        }
        if (call.input.action === "await_chat") {
          return {
            callId: call.id,
            ok: true,
            meta: {
              yieldReturn: true,
              yieldAction: "await_chat" as const,
              yieldSeconds: 900
            }
          };
        }
        if (call.input.action === "schedule" && typeof call.input.timer === "number") {
          return {
            callId: call.id,
            ok: true,
            meta: {
              yieldReturn: true,
              yieldAction: "schedule" as const,
              yieldSeconds: Number(call.input.timer)
            }
          };
        }
        return { callId: call.id, ok: false, error: "invalid yield input" };
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
