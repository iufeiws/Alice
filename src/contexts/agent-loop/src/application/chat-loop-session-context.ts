import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMChatInput, LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import type { AgentEvent, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";
import { formatAgentLoopToolMessageContent, runPromptToolRequest as executePromptToolRequest } from "./agent-loop-tool-executor.js";
import type { ChatAgentLoopInput, ChatAgentLoopSession, ChatAgentModeState } from "./run-chat-loop.js";

export async function buildWaitChatResumeMessages(input: {
  session: ChatAgentLoopSession;
  event: AgentEvent;
  toolPlugins: ToolPlugin[];
  time: CurrentTimeProvider;
  buildTextVariables(event: AgentEvent): PromptContextRuntime;
  onLLMLog?: ChatAgentLoopInput["onLLMLog"];
}): Promise<LLMChatInput["messages"]> {
  const pending = pendingWaitChatToolCalls(input.session.messages);
  if (!pending) return [];
  const messages: LLMChatInput["messages"] = [];
  const textVariables = input.buildTextVariables(input.event);
  let waitChatCheckResult: ToolResult | undefined;
  for (const call of pending.calls) {
    let result: ToolResult;
    if (isWaitChatToolName(call.function.name)) {
      waitChatCheckResult ??= await runWaitChatResumeCheck(call.id, input.session, input.event, input.toolPlugins);
      result = {
        ...waitChatCheckResult,
        callId: call.id,
        output: formatWaitChatResumeOutput(waitChatCheckResult, input.session.waitChatStartedAt, input.time, input.onLLMLog)
      };
    } else {
      const toolInput = fixedPrefixToolInput(call.function.name, parseToolArguments(call.function.arguments), input.session);
      result = await executePromptToolRequest(
        { id: `finish_and_wait_resume_${call.id}`, title: "finish_and_wait resume", role: "tool_request", enabled: true, content: "", toolCalls: [{ toolName: call.function.name, toolArguments: call.function.arguments }], order: 0 },
        {
          id: call.id,
          toolName: call.function.name,
          input: toolInput,
          requester: input.event.source,
          externalSession: input.event.externalSession
        },
        input.toolPlugins
      );
      if (isCheckChatToolName(call.function.name)) waitChatCheckResult ??= result;
    }
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.function.name,
      content: formatToolMessageContent(result, textVariables)
    });
  }
  return messages;
}

export function findToolPlugin(tools: ToolPlugin[], toolName: string): ToolPlugin | undefined {
  return tools.find((plugin) => plugin.listTools().some((tool) => tool.name === toolName));
}

export function defaultChatAgentModeState(): ChatAgentModeState {
  return { mode: "normal", modeStaticMessages: [], modeStaticTokenEstimate: 0, tokenPressurePreviewBaselines: {} };
}

export function cloneLLMMessages(messages: LLMChatInput["messages"]): LLMChatInput["messages"] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  }));
}

export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += /[\u4e00-\u9fff]/.test(char) ? 0.6 : 0.3;
  }
  return Math.round(tokens);
}

export function estimateMessagesTokens(messages: LLMChatInput["messages"]): number {
  return estimateTextTokens(messages.map((message) => [
    message.role,
    message.content,
    message.reasoningContent ?? "",
    message.name ?? "",
    message.toolCallId ?? "",
    JSON.stringify(message.toolCalls ?? [])
  ].join("\n")).join("\n"));
}

export function toolResultText(result: ToolResult): string {
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined || result.output === null) return result.error ?? "";
  try {
    return JSON.stringify(result.output);
  } catch {
    return String(result.output);
  }
}

export function fixedPrefixToolInput(toolName: string, input: Record<string, unknown>, session: ChatAgentLoopSession): Record<string, unknown> {
  if (
    session.mode !== "fixed_prefix"
    || !isCheckChatToolName(toolName)
    || input.action !== "poll"
  ) {
    return input;
  }
  if (!session.fixedPrefixStartedAt) throw new Error("fixed_prefix_started_at_missing");
  return {
    ...input,
    scope: "range",
    from: session.fixedPrefixStartedAt
  };
}

function pendingWaitChatToolCalls(messages: LLMChatInput["messages"]): { calls: LLMToolCall[] } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) continue;
    const followingToolCallIds = new Set(
      messages
        .slice(index + 1)
        .filter((entry) => entry.role === "tool" && typeof entry.toolCallId === "string")
        .map((entry) => entry.toolCallId as string)
    );
    const missingCalls = message.toolCalls.filter((call) => !followingToolCallIds.has(call.id));
    if (!missingCalls.some((call) => isWaitChatToolName(call.function.name))) return undefined;
    return { calls: missingCalls };
  }
  return undefined;
}

async function runWaitChatResumeCheck(
  callId: string,
  session: ChatAgentLoopSession,
  event: AgentEvent,
  toolPlugins: ToolPlugin[]
): Promise<ToolResult> {
  const checkInput = session.mode === "fixed_prefix"
    ? fixedPrefixToolInput("Chat", { action: "poll" }, session)
    : { action: "poll" };
  return await executePromptToolRequest(
    { id: "finish_and_wait_resume_chat_poll", title: "finish_and_wait resume", role: "tool_request", enabled: true, content: "", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 0 },
    {
      id: callId,
      toolName: "Chat",
      input: checkInput,
      requester: event.source,
      externalSession: event.externalSession
    },
    toolPlugins
  );
}

function formatWaitChatResumeOutput(
  result: ToolResult,
  waitChatStartedAt: number | undefined,
  time: CurrentTimeProvider,
  onLLMLog?: ChatAgentLoopInput["onLLMLog"]
): unknown {
  if (typeof result.output !== "string") return result.output;
  if (typeof waitChatStartedAt !== "number" || !Number.isFinite(waitChatStartedAt)) {
    onLLMLog?.({
      kind: "finish_and_wait_resume_error",
      round: 0,
      stream: false,
      error: "finish_and_wait resume missing start time"
    });
    return result.output;
  }
  const duration = formatWaitChatDuration(time.now().epochMs - waitChatStartedAt);
  if (!duration) return result.output;
  const timeMarker = "\n<now ";
  const index = result.output.lastIndexOf(timeMarker);
  if (index === -1) return `${result.output}\n<wait-duration>${duration}</wait-duration>`;
  return `${result.output.slice(0, index)}\n<wait-duration>${duration}</wait-duration>${result.output.slice(index)}`;
}

function formatWaitChatDuration(durationMs: number): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function isCheckChatToolName(toolName: string): boolean {
  return toolName === "Chat";
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatToolMessageContent(result: ToolResult, variables: PromptContextRuntime): string {
  return formatAgentLoopToolMessageContent(result, variables);
}

function isWaitChatToolName(toolName: string | undefined): boolean {
  return toolName === "Yield";
}
