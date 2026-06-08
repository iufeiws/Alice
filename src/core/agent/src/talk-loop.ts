import type { CurrentTimeProvider } from "../../time/src/index.js";
import type { LLMMessage, LLMToolCall } from "../../../../contexts/llm-gateway/src/index.js";
import type { LLMRequestSender, LLMRequestSenderInput } from "../../../../contexts/llm-gateway/src/llm-tool-loop.js";
import type { AgentEvent, ToolCall, ToolPlugin, ToolResult } from "../../../packages/types/src/index.js";
import { buildPromptMessagesWithToolResults, promptVariables, type PromptProfile, type PromptRenderContext } from "./prompts.js";
import { formatToolResultForLLM } from "../../text-renderer/src/index.js";
import { runChatAgentLoop, type ChatAgentLoopInput, type ChatAgentLoopResult, type ChatAgentLoopSession } from "./chat-loop.js";

export type TalkAgentLoopSession = ChatAgentLoopSession;
export type TalkAgentLoopInput = Omit<ChatAgentLoopInput, "llmInput"> & {
  llmInput: ChatAgentLoopInput["llmInput"];
};
export type TalkAgentLoopResult = ChatAgentLoopResult;

type TalkAgentLoopLogLevel = "info" | "warn" | "error";
type TalkAgentLoopLLMConfig = {
  client: NonNullable<LLMRequestSenderInput["client"]>;
  model?: string;
  temperature?: number;
  extraParams?: Record<string, unknown>;
  followupExtraParams?: Record<string, unknown>;
  stream?: boolean;
};

type TalkAgentLoopState = {
  promptMessages: LLMMessage[];
  initialTalkMessages: LLMMessage[];
  toolNames: string[];
  toolVariables: Record<string, unknown> | undefined;
  executeToolCall(call: LLMToolCall): Promise<string>;
};

type TalkAgentLoopDeps = {
  isActiveTalkLLMSession(sessionId: string): boolean;
  getActiveTalkLLMSessionId(): string | number | undefined;
  getTalkPromptProfile(): PromptProfile;
  time: CurrentTimeProvider;
  dailyShellStore: {
    render(date: Date, timeZone: string): string;
    get(date: Date, timeZone: string): PromptRenderContext["dailyShellRaw"];
  };
  getAppearanceDescription(): string | undefined;
  memoryStore: { read(): PromptRenderContext["memory"] };
  diaryStore: { latestWakeBoundary(): PromptRenderContext["wakeBoundary"] };
  buildNextLoopMessages(sessionId: string): Promise<LLMMessage[]> | LLMMessage[];
  visibleToolNames(profile: PromptProfile): string[];
  toolPlugins: readonly ToolPlugin[];
  getLLMConfig(): TalkAgentLoopLLMConfig;
  sendRequest: LLMRequestSender;
  appendAssistantDelta(input: { sessionId: string; outputId: string; delta: string }): void;
  finishAssistantOutput(input: { sessionId: string; outputId: string }): void;
  log(level: TalkAgentLoopLogLevel, message: string): void;
};

export type TalkAgentLoopController = {
  runTalkAgentLoopForSession(sessionId: string): Promise<void>;
  interruptTalkAgentLoop(sessionId: string): void;
  getConversationStartIndex(sessionId: string): number | undefined;
};

export function createTalkAgentLoopForSession(deps: TalkAgentLoopDeps): TalkAgentLoopController {
  const activeTalkAgentLoops = new Set<string>();
  const activeTalkAgentLoopControllers = new Map<string, AbortController>();
  const activeTalkConversationStartIndexes = new Map<string, number>();

  async function runTalkAgentLoopForSession(sessionId: string): Promise<void> {
    if (activeTalkAgentLoops.has(sessionId)) return;
    if (!deps.isActiveTalkLLMSession(sessionId)) {
      deps.log("warn", `talk loop skipped: session id mismatch session=${sessionId} active=${deps.getActiveTalkLLMSessionId() ?? "none"}`);
      return;
    }
    activeTalkAgentLoops.add(sessionId);
    const controller = new AbortController();
    activeTalkAgentLoopControllers.set(sessionId, controller);
    try {
      deps.log("info", `talk loop start: session=${sessionId}`);
      const { promptMessages, initialTalkMessages, toolNames, toolVariables, executeToolCall } = await buildTalkAgentLoopState(sessionId);
      activeTalkConversationStartIndexes.set(sessionId, promptMessages.length);
      let messages: LLMMessage[] = [
        ...promptMessages,
        ...initialTalkMessages
      ];
      const config = deps.getLLMConfig();
      for (let round = 0; true; round += 1) {
        const outputId = `talk:${sessionId}:${Date.now()}:${round}`;
        let streamedContent = "";
        const result = await deps.sendRequest({
          agentId: "talk",
          client: config.client,
          messages,
          model: config.model,
          temperature: config.temperature,
          extraParams: round === 0 ? config.extraParams : config.followupExtraParams,
          toolNames,
          toolVariables,
          round,
          stream: config.stream !== false,
          signal: controller.signal,
          streamHandlers: {
            onContentDelta(delta) {
              streamedContent += delta;
              deps.appendAssistantDelta({ sessionId, outputId, delta });
            }
          }
        });
        const calls = result.message.toolCalls ?? [];
        if (calls.length === 0) {
          if (!streamedContent && result.message.content) {
            deps.appendAssistantDelta({ sessionId, outputId, delta: result.message.content });
          }
          deps.finishAssistantOutput({ sessionId, outputId });
          deps.log("info", `talk loop output ready: session=${sessionId} output=${outputId}`);
          //return;
        }
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.message.content,
            reasoningContent: result.message.reasoningContent,
            toolCalls: calls
          },
          ...await Promise.all(calls.map(async (call) => ({
            role: "tool" as const,
            toolCallId: call.id,
            name: call.function.name,
            content: await executeToolCall(call)
          })))
        ];
      }
    } catch (error) {
      deps.log("error", `talk loop failed: session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (activeTalkAgentLoopControllers.get(sessionId) === controller) {
        activeTalkAgentLoopControllers.delete(sessionId);
      }
      activeTalkAgentLoops.delete(sessionId);
    }
  }

  function interruptTalkAgentLoop(sessionId: string): void {
    activeTalkAgentLoopControllers.get(sessionId)?.abort();
  }

  function getConversationStartIndex(sessionId: string): number | undefined {
    return activeTalkConversationStartIndexes.get(sessionId);
  }

  async function buildTalkAgentLoopState(sessionId: string): Promise<TalkAgentLoopState> {
    const profile = deps.getTalkPromptProfile();
    const event = buildTalkAgentEvent(sessionId, deps.time);
    const context = {
      event,
      time: deps.time,
      dailyShell: deps.dailyShellStore.render(deps.time.now().date, deps.time.timeZone),
      dailyShellRaw: deps.dailyShellStore.get(deps.time.now().date, deps.time.timeZone),
      appearanceDescription: deps.getAppearanceDescription(),
      memory: deps.memoryStore.read(),
      wakeBoundary: deps.diaryStore.latestWakeBoundary()
    };
    const variables = promptVariables(profile, context);
    const runPromptTool = async (_layer: unknown, call: ToolCall) => executeTalkToolCall(context.event, call, variables);
    const promptMessages: LLMMessage[] = await buildPromptMessagesWithToolResults(profile, context, runPromptTool as Parameters<typeof buildPromptMessagesWithToolResults>[2]);
    const talkMessages = await Promise.resolve(deps.buildNextLoopMessages(sessionId));
    const initialTalkMessages = talkMessages.length ? talkMessages : [{
      role: "user" as const,
      content: "A realtime voice call has just connected. Start with a short, natural voice greeting."
    }];
    return {
      promptMessages,
      initialTalkMessages,
      toolNames: deps.visibleToolNames(profile),
      toolVariables: variables,
      executeToolCall: (call: LLMToolCall) => executeTalkLLMToolCall(event, call)
        .then((result) => formatToolResultForLLM(result))
    };
  }

  async function executeTalkLLMToolCall(event: AgentEvent, call: LLMToolCall): Promise<ToolResult> {
    return executeTalkToolCall(event, {
      id: call.id,
      toolName: call.function.name,
      input: parseToolArguments(call.function.arguments)
    }, promptVariables(deps.getTalkPromptProfile(), {
      event,
      time: deps.time,
      dailyShell: deps.dailyShellStore.render(deps.time.now().date, deps.time.timeZone),
      dailyShellRaw: deps.dailyShellStore.get(deps.time.now().date, deps.time.timeZone),
      appearanceDescription: deps.getAppearanceDescription(),
      memory: deps.memoryStore.read(),
      wakeBoundary: deps.diaryStore.latestWakeBoundary()
    }));
  }

  async function executeTalkToolCall(
    _event: AgentEvent,
    call: ToolCall,
    _variables: ReturnType<typeof promptVariables>
  ): Promise<ToolResult> {
    if (isOutboundMessagingTool(call.toolName)) {
      return {
        callId: call.id,
        ok: false,
        error: "Talk loop outputs through TalkRuntime voice chunks; do not use messaging send tools."
      };
    }
    const plugin = deps.toolPlugins.find((entry) => entry.listTools().some((tool) => tool.name === call.toolName));
    if (!plugin) {
      return {
        callId: call.id,
        ok: false,
        error: `Unknown tool: ${call.toolName}`
      };
    }
    try {
      return await plugin.execute({
        id: call.id,
        toolName: call.toolName,
        input: call.input,
        requester: _event.source,
        session: _event.session
      });
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    runTalkAgentLoopForSession,
    interruptTalkAgentLoop,
    getConversationStartIndex
  };
}

function buildTalkAgentEvent(sessionId: string, time: CurrentTimeProvider): AgentEvent {
  const now = time.now();
  return {
    id: `talk_${sessionId}_${now.epochMs}`,
    source: {
      plugin: "webrtc_voice",
      channelId: sessionId,
      userId: sessionId
    },
    session: {
      scope: "dm",
      sessionId
    },
    type: "message.text",
    payload: {
      kind: "text",
      text: "A realtime voice call event was received."
    },
    meta: {
      receivedAt: now.iso,
      receivedAtUtc: now.date.toISOString()
    }
  } as const;
}

function isOutboundMessagingTool(name: string): boolean {
  return name === "send_chat" || name === "send_feishu" || name === "send_wechat";
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function runTalkAgentLoop(input: TalkAgentLoopInput): Promise<TalkAgentLoopResult> {
  return runChatAgentLoop({
    ...input,
    llmInput: {
      ...input.llmInput,
      agentId: "talk"
    }
  });
}
