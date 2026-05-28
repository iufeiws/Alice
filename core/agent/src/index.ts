import type { AppConfig } from "../../../packages/config/src/index.js";
import type { LLMChatInput, LLMChatResult, LLMClient, LLMToolCallDelta } from "../../llm/src/index.js";
import type { OutputRouter } from "../../output-router/src/index.js";
import type { PolicyEngine } from "../../policy/src/index.js";
import type { IntentRouter } from "../../router/src/index.js";
import type { SessionResolver } from "../../session/src/index.js";
import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../time/src/index.js";
import type { AgentEvent, AgentOutput, ChannelPlugin, ToolPlugin, ToolResult } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import { buildPromptMessagesWithToolResults, defaultPromptProfile, type PromptLayer, type PromptProfile } from "./prompts.js";
import type { AgentStateController, AgentStateSnapshot } from "./state.js";

const sendChatToolName = "send_chat";

export type AgentCoreDeps = {
  config: AppConfig;
  llm: LLMClient;
  intentRouter: IntentRouter;
  sessionResolver: SessionResolver;
  policy: PolicyEngine;
  outputRouter: OutputRouter;
  memory?: {
    recall(event: AgentEvent): Promise<string[]>;
    capture(event: AgentEvent, outputs: AgentOutput[]): Promise<void>;
  };
  tools?: ToolPlugin[];
  getPromptProfile?: () => PromptProfile;
  getDailyShell?: () => string;
  state?: AgentStateController;
  time?: CurrentTimeProvider;
  onLLMRequestPrepared?(input: LLMChatInput): void;
  onLLMResponseReceived?(result: LLMChatResult): void;
  onLLMLog?(event: { kind: "call_start" | "stream_start" | "stream_end" | "response_received"; round: number; stream: boolean; model?: string }): void;
  onLLMSessionCompleted?(result: { sentMessage: boolean }): void;
};

export interface AgentCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleEvent(event: AgentEvent): Promise<AgentOutput[]>;
  getState(): AgentStateSnapshot | undefined;
  registerChannel(plugin: ChannelPlugin): void;
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const channels: ChannelPlugin[] = [];
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  let lastCompletedToolName: string | undefined;

  return {
    async start() {
      deps.state?.start();
      await Promise.all(channels.map((channel) => channel.start()));
    },
    async stop() {
      await Promise.all([...channels].reverse().map((channel) => channel.stop()));
      deps.state?.stop();
    },
    getState() {
      return deps.state?.getSnapshot();
    },
    registerChannel(plugin) {
      channels.push(plugin);
      deps.outputRouter.register(plugin);
    },
    async handleEvent(event) {
      const decision = await deps.policy.check(event);
      if (!decision.allowed) {
        return [
          buildReply(event, time, {
            kind: "text",
            text: decision.reason ? `Request denied: ${decision.reason}` : "Request denied."
          })
        ];
      }

      const sessionId = await deps.sessionResolver.resolve(event);
      const routed = deps.intentRouter.route({
        ...event,
        session: { ...event.session, sessionId }
      });

      if (routed.kind === "unsupported") {
        return [buildReply(event, time, { kind: "text", text: routed.reason })];
      }

      const serious = routed.kind === "codex";
      deps.state?.noteWorkStarted({ serious });
      try {
        if (routed.kind === "codex") {
          return [
            buildReply(event, time, {
              kind: "markdown",
              markdown: `Codex command accepted by router, but Codex worker is not implemented yet.\n\nPrompt: ${routed.prompt || "(empty)"}`
            })
          ];
        }

        const promptProfile = deps.getPromptProfile?.() ?? defaultPromptProfile();
        const toolPlugins = filterVisibleTools(deps.tools ?? [], promptProfile);
        const promptMessages = await buildPromptMessagesWithToolResults(promptProfile, {
          event,
          time,
          dailyShell: deps.getDailyShell?.()
        }, (layer, call) => {
          return runPromptToolRequest(layer, call, toolPlugins);
        });
        if (promptMessages.length === 0) {
          return [];
        }
        const llmInput = {
          messages: [
            ...promptMessages
          ],
          model: deps.config.llm.model,
          temperature: deps.config.llm.temperature,
          tools: toolPlugins.flatMap((plugin) => plugin.listTools().map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema
            }
          })))
        } satisfies LLMChatInput;
        let sentMessage = false;
        try {
          const llmResult = await runLLMTurnWithTools(llmInput, event, toolPlugins);
          sentMessage = llmResult.sentMessage;
        } finally {
          deps.onLLMSessionCompleted?.({ sentMessage });
        }

        return [];
      } finally {
        deps.state?.noteWorkFinished();
      }
    }
  };

  async function runLLMTurnWithTools(
    input: LLMChatInput,
    event: AgentEvent,
    toolPlugins: ToolPlugin[]
  ): Promise<{ message: LLMChatInput["messages"][number]; sentMessage: boolean }> {
    const toolMap = new Map<string, ToolPlugin>();
    for (const plugin of toolPlugins) {
      for (const tool of plugin.listTools()) {
        toolMap.set(tool.name, plugin);
      }
      if (plugin.id === "messaging" && toolMap.has(sendChatToolName)) {
        toolMap.set("check_feishu", plugin);
        toolMap.set("check_wechat", plugin);
        toolMap.set("view_messages", plugin);
        toolMap.set("send_feishu", plugin);
        toolMap.set("send_wechat", plugin);
        toolMap.set("send_message", plugin);
      }
    }

    let nextInput = input;
    let sentMessage = false;
    let previousToolCallSignature: string | undefined;
    let repeatedToolCallCount = 0;
    let sendChatCallCount = 0;
    let totalToolCallCount = 0;
    let round = 0;
    const maxLLMRequests = 12;
    const maxTotalToolCalls = 20;
    while (true) {
      const requestInput = {
        ...nextInput,
        extraParams: round === 0 ? deps.config.llm.extraParams : deps.config.llm.followupExtraParams
      };
      deps.onLLMRequestPrepared?.(requestInput);
      const useStream = deps.config.llm.stream !== false && Boolean(deps.llm.chatStream);
      deps.onLLMLog?.({ kind: "call_start", round, stream: useStream, model: requestInput.model });
      const streamingToolSender = createStreamingSendMessageHandler(event, toolMap);
      let result: LLMChatResult;
      if (useStream && deps.llm.chatStream) {
        deps.onLLMLog?.({ kind: "stream_start", round, stream: true, model: requestInput.model });
        try {
          result = await deps.llm.chatStream(requestInput, {
            onToolCallDelta(delta) {
              return streamingToolSender.onToolCallDelta(delta);
            }
          });
        } finally {
          deps.onLLMLog?.({ kind: "stream_end", round, stream: true, model: requestInput.model });
        }
      } else {
        result = await deps.llm.chat(requestInput);
        deps.onLLMLog?.({ kind: "response_received", round, stream: false, model: requestInput.model });
      }
      await streamingToolSender.finish();
      deps.onLLMResponseReceived?.(result);
      const calls = result.message.toolCalls ?? [];
      if (calls.length === 0) return { message: result.message, sentMessage };

      const effectiveCalls = calls.some((call) => isSendChatToolName(call.function.name))
        ? calls.filter((call) => isSendChatToolName(call.function.name))
        : calls;
      let reachedToolCallLimit = false;
      let previousToolNameForConsecutiveCheck = lastCompletedToolName;
      const toolMessages = await Promise.all(effectiveCalls.map(async (call) => {
        totalToolCallCount += 1;
        if (totalToolCallCount >= maxTotalToolCalls) reachedToolCallLimit = true;
        const isConsecutiveSelfie = call.function.name === "selfie" && previousToolNameForConsecutiveCheck === "selfie";
        previousToolNameForConsecutiveCheck = call.function.name;
        const currentToolCallSignature = toolCallSignature(call.function.name, call.function.arguments);
        if (currentToolCallSignature === previousToolCallSignature) {
          repeatedToolCallCount += 1;
        } else {
          previousToolCallSignature = currentToolCallSignature;
          repeatedToolCallCount = 1;
        }
        if (repeatedToolCallCount >= 3) reachedToolCallLimit = true;
        if (isSendChatToolName(call.function.name)) {
          sendChatCallCount += 1;
          if (sendChatCallCount >= 5) reachedToolCallLimit = true;
        }
        const streamedResult = streamingToolSender.resultFor(call.id);
        if (streamedResult) {
          sentMessage = sentMessage || isSendChatToolName(call.function.name) && streamedResult.ok;
          lastCompletedToolName = call.function.name;
          return {
            role: "tool" as const,
            toolCallId: call.id,
            name: call.function.name,
            content: formatToolResultForLLM(streamedResult)
          };
        }
        const plugin = toolMap.get(call.function.name);
        let toolResult: ToolResult;
        if (isConsecutiveSelfie) {
          toolResult = {
            callId: call.id,
            ok: false,
            error: "selfie cannot be called twice in a row"
          };
        } else if (!plugin) {
          toolResult = {
            callId: call.id,
            ok: false,
            error: `Unknown tool: ${call.function.name}`
          };
        } else {
          try {
            toolResult = await plugin.execute({
              id: call.id,
              toolName: call.function.name,
              input: parseToolArguments(call.function.arguments),
              requester: event.source,
              session: event.session
            });
          } catch (error) {
            toolResult = {
              callId: call.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }

        sentMessage = sentMessage || isSendChatToolName(call.function.name) && toolResult.ok;
        lastCompletedToolName = call.function.name;
        return {
          role: "tool" as const,
          toolCallId: call.id,
          name: call.function.name,
          content: formatToolResultForLLM(toolResult)
        };
      }));

      if (reachedToolCallLimit || round + 1 >= maxLLMRequests) {
        return { message: result.message, sentMessage };
      }

      nextInput = {
        ...nextInput,
        messages: [
          ...nextInput.messages,
          {
            role: "assistant",
            content: result.message.content,
            reasoningContent: reasoningContentForToolRequest(result.message.reasoningContent, effectiveCalls.length),
            toolCalls: effectiveCalls
          },
          ...toolMessages
        ]
      };
      round += 1;
    }
  }

  function createStreamingSendMessageHandler(event: AgentEvent, toolMap: Map<string, ToolPlugin>) {
    const states = new Map<number, StreamingSendMessageState>();
    const resultsByCallId = new Map<string, ToolResult>();
    const sentCounts = new Map<string, number>();
    let sendChain = Promise.resolve();

    return {
      onToolCallDelta(delta: LLMToolCallDelta) {
        const state = states.get(delta.index) ?? new StreamingSendMessageState();
        states.set(delta.index, state);
        const { readyLines } = state.accept(delta);
        const lines = state.canStreamNow() ? readyLines : [];
        if (lines.length === 0) return;
        const callId = state.callId;
        const plugin = toolMap.get(sendChatToolName);
        if (!callId || !plugin || !isSendChatToolName(state.toolName)) {
          state.restoreReadyLines(lines);
          return;
        }
        state.dropPendingLines();
        sendChain = sendChain.then(async () => {
          for (const line of lines) {
            const sentCount = sentCounts.get(callId) ?? 0;
            await sendStreamingLine(plugin, event, callId, line, resultsByCallId);
            sentCounts.set(callId, sentCount + 1);
          }
        });
      },
      async finish() {
        for (const state of states.values()) {
          const lines = state.finish();
          const callId = state.callId;
          const plugin = toolMap.get(sendChatToolName);
          if (!callId || !plugin || !isSendChatToolName(state.toolName) || !state.shouldSendAsMessage()) continue;
          sendChain = sendChain.then(async () => {
            for (const line of lines) {
              const sentCount = sentCounts.get(callId) ?? 0;
              await sendStreamingLine(plugin, event, callId, line, resultsByCallId);
              sentCounts.set(callId, sentCount + 1);
            }
          });
        }
        await sendChain;
      },
      resultFor(callId: string) {
        return resultsByCallId.get(callId);
      }
    };
  }

  async function runPromptToolRequest(
    layer: PromptLayer,
    call: {
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      requester?: AgentEvent["source"];
      session?: AgentEvent["session"];
    },
    toolPlugins: ToolPlugin[]
  ): Promise<ToolResult> {
    if (isSendChatToolName(call.toolName)) {
      return {
        callId: call.id,
        ok: false,
        error: "send_chat cannot run from prompt prebuild"
      };
    }
    const plugin = findToolPlugin(toolPlugins, call.toolName);
    if (!plugin) {
      return {
        callId: call.id,
        ok: false,
        error: `Unknown prompt tool: ${call.toolName}`
      };
    }
    try {
      return await plugin.execute(call);
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function filterVisibleTools(tools: ToolPlugin[], profile: PromptProfile): ToolPlugin[] {
  return tools.filter((plugin) => {
    if (plugin.id === "messaging") return profile.visibleTools.feishu !== false;
    if (plugin.id === "media") return profile.visibleTools.media !== false;
    return true;
  });
}

function findToolPlugin(tools: ToolPlugin[], toolName: string): ToolPlugin | undefined {
  return tools.find((plugin) => plugin.listTools().some((tool) => tool.name === toolName));
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toolCallSignature(name: string, rawArguments: string): string {
  return `${name}:${stableJson(parseToolArguments(rawArguments))}`;
}

function reasoningContentForToolRequest(reasoningContent: string | undefined, toolCallCount: number): string | undefined {
  if (reasoningContent) return reasoningContent;
  return toolCallCount > 0 ? "Need to call the requested tool." : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatToolResultForLLM(result: ToolResult): string {
  if (!result.ok && typeof result.output === "string") return result.output;
  if (!result.ok) return result.error ? `error: ${result.error}` : "error";
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  try {
    return JSON.stringify(result.output);
  } catch {
    return String(result.output);
  }
}

async function sendStreamingLine(
  plugin: ToolPlugin,
  event: AgentEvent,
  callId: string,
  line: string,
  resultsByCallId: Map<string, ToolResult>
): Promise<void> {
  const previous = resultsByCallId.get(callId);
  const previousOutput = typeof previous?.output === "string" ? previous.output : "";
  try {
    const result = await plugin.execute({
      id: `${callId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      toolName: sendChatToolName,
      input: { type: "message", content: line },
      requester: event.source,
      session: event.session
    });
    const output = formatToolResultForLLM(result);
    resultsByCallId.set(callId, {
      callId,
      ok: previous?.ok === false ? false : result.ok,
      output: mergeToolOutputs(previousOutput, output),
      error: previous?.error ?? result.error
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    resultsByCallId.set(callId, {
      callId,
      ok: false,
      output: previousOutput,
      error: previous?.error ?? reason
    });
  }
}

function isSendChatToolName(toolName: string | undefined): boolean {
  return toolName === sendChatToolName || toolName === "send_feishu" || toolName === "send_wechat" || toolName === "send_message";
}

function mergeToolOutputs(previousOutput: string, nextOutput: string): string {
  if (!previousOutput) return nextOutput;
  if (!nextOutput) return previousOutput;
  const previousChat = parseChatToolOutput(previousOutput);
  const nextChat = parseChatToolOutput(nextOutput);
  if (!previousChat || !nextChat) return [previousOutput, nextOutput].filter(Boolean).join("\n");
  return `<chat-log>\n${[previousChat.body, nextChat.body].filter(Boolean).join("\n")}\n</chat-log>\n<time>${nextChat.currentTime}<\\time>`;
}

function parseChatToolOutput(output: string): { body: string; currentTime: string } | undefined {
  const match = /^<chat-log>\n([\s\S]*)\n<\/chat-log>\n<time>([\s\S]*?)<\\time>$/.exec(output.trim());
  if (!match) return undefined;
  return { body: match[1], currentTime: match[2] };
}

class StreamingSendMessageState {
  callId?: string;
  toolName?: string;
  private argumentsText = "";
  private scanIndex = 0;
  private contentStarted = false;
  private contentDone = false;
  private escaped = false;
  private unicodeBuffer = "";
  private pendingLine = "";
  private readyLines: string[] = [];
  private pendingLines: string[] = [];
  private sawExplicitMessageType = false;
  private sawNonMessageType = false;

  accept(delta: LLMToolCallDelta): { readyLines: string[]; pendingLines: string[] } {
    if (delta.id) this.callId = delta.id;
    if (delta.function?.name) this.toolName = delta.function.name;
    if (delta.function?.arguments) {
      this.argumentsText += delta.function.arguments;
      this.updateTypeState();
      this.scan();
    }
    return {
      readyLines: this.drainReadyLines(),
      pendingLines: [...this.pendingLines]
    };
  }

  finish(): string[] {
    const lines = this.shouldSendAsMessage() ? [...this.pendingLines, ...this.drainReadyLines()] : [];
    this.pendingLines = [];
    const tail = this.pendingLine.trim();
    if (tail && this.shouldSendAsMessage()) lines.push(tail);
    this.pendingLine = "";
    return lines;
  }

  canStreamNow(): boolean {
    return this.sawExplicitMessageType && !this.sawNonMessageType;
  }

  shouldSendAsMessage(): boolean {
    return !this.sawNonMessageType;
  }

  dropPendingLines(): void {
    this.pendingLines = [];
  }

  private updateTypeState(): void {
    const typeMatch = /"type"\s*:\s*"([^"]*)"/.exec(this.argumentsText);
    if (!typeMatch) return;
    this.sawExplicitMessageType = typeMatch[1] === "message";
    this.sawNonMessageType = typeMatch[1] !== "message";
  }

  private scan(): void {
    if (!this.contentStarted) {
      const match = /"content"\s*:\s*"/.exec(this.argumentsText.slice(this.scanIndex));
      if (!match) return;
      this.scanIndex += match.index + match[0].length;
      this.contentStarted = true;
    }

    while (this.scanIndex < this.argumentsText.length && !this.contentDone) {
      const char = this.argumentsText[this.scanIndex];
      this.scanIndex += 1;
      if (this.unicodeBuffer) {
        this.unicodeBuffer += char;
        if (this.unicodeBuffer.length === 4) {
          this.pushDecoded(String.fromCharCode(Number.parseInt(this.unicodeBuffer, 16)));
          this.unicodeBuffer = "";
          this.escaped = false;
        }
        continue;
      }
      if (this.escaped) {
        if (char === "u") {
          this.unicodeBuffer = "";
          continue;
        }
        this.pushDecoded(decodeJsonEscape(char));
        this.escaped = false;
        continue;
      }
      if (char === "\\") {
        this.escaped = true;
        continue;
      }
      if (char === "\"") {
        this.contentDone = true;
        continue;
      }
      this.pushDecoded(char);
    }
  }

  private pushDecoded(char: string): void {
    if (char === "\n") {
      const line = this.pendingLine.trim();
      if (line) {
        if (this.canStreamNow()) {
          this.readyLines.push(line);
        } else {
          this.pendingLines.push(line);
        }
      }
      this.pendingLine = "";
      return;
    }
    if (char !== "\r") this.pendingLine += char;
  }

  private drainReadyLines(): string[] {
    const lines = this.readyLines;
    this.readyLines = [];
    return lines;
  }

  restoreReadyLines(lines: string[]): void {
    this.readyLines = [...lines, ...this.readyLines];
  }
}

function decodeJsonEscape(char: string): string {
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";
  if (char === "b") return "\b";
  if (char === "f") return "\f";
  return char;
}

function buildReply(
  event: AgentEvent,
  time: CurrentTimeProvider,
  content: AgentOutput["content"]
): AgentOutput {
  return {
    id: createId("out"),
    target: {
      plugin: event.source.plugin,
      accountId: event.source.accountId,
      channelId: event.source.channelId,
      userId: event.source.userId,
      sessionId: event.session.sessionId,
      replyTo: event.meta.replyTo ?? event.source.rawMessageId
    },
    content,
    meta: {
      createdAt: time.now().iso,
      urgency: "normal",
      allowStreaming: false
    }
  };
}
