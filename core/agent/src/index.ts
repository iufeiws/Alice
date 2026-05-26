import type { AppConfig } from "../../../packages/config/src/index.js";
import type { LLMChatInput, LLMClient, LLMToolCallDelta } from "../../llm/src/index.js";
import type { OutputRouter } from "../../output-router/src/index.js";
import type { PolicyEngine } from "../../policy/src/index.js";
import type { IntentRouter } from "../../router/src/index.js";
import type { SessionResolver } from "../../session/src/index.js";
import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../time/src/index.js";
import type { AgentEvent, AgentOutput, ChannelPlugin, ToolPlugin, ToolResult } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import { getPromptContent } from "./prompts.js";
import type { AgentStateController, AgentStateSnapshot } from "./state.js";

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
  state?: AgentStateController;
  time?: CurrentTimeProvider;
  onLLMRequestPrepared?(input: LLMChatInput): void;
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

        const recalled = await deps.memory?.recall(event) ?? [];
        const toolPlugins = deps.tools ?? [];
        const llmInput = {
          messages: [
            {
              role: "system",
              content: getPromptContent("agent.placeholder.system")
            },
            ...(recalled.length > 0
              ? [{
                  role: "system" as const,
                  content: `Relevant persistent memory:\n${recalled.map((item) => `- ${item}`).join("\n")}`
                }]
              : []),
            { role: "user", content: routed.text }
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
        const llmResult = await runLLMTurnWithTools(llmInput, event, toolPlugins);

        const outputs = [
          buildReply(event, time, {
            kind: "text",
            text: llmResult.message.content || `Echo: ${routed.text}`
          })
        ];
        await deps.memory?.capture(event, outputs);
        return outputs;
      } finally {
        deps.state?.noteWorkFinished();
      }
    }
  };

  async function runLLMTurnWithTools(
    input: LLMChatInput,
    event: AgentEvent,
    toolPlugins: ToolPlugin[]
  ) {
    const toolMap = new Map<string, ToolPlugin>();
    for (const plugin of toolPlugins) {
      for (const tool of plugin.listTools()) {
        toolMap.set(tool.name, plugin);
      }
    }

    let nextInput = input;
    const maxToolRounds = 2;
    for (let round = 0; round <= maxToolRounds; round += 1) {
      deps.onLLMRequestPrepared?.(nextInput);
      const streamingToolSender = createStreamingSendMessageHandler(event, toolMap);
      const result = deps.llm.chatStream
        ? await deps.llm.chatStream(nextInput, {
            onToolCallDelta(delta) {
              return streamingToolSender.onToolCallDelta(delta);
            }
          })
        : await deps.llm.chat(nextInput);
      await streamingToolSender.finish();
      const calls = result.message.toolCalls ?? [];
      if (calls.length === 0 || round === maxToolRounds) return result;

      const toolMessages = await Promise.all(calls.map(async (call) => {
        const streamedResult = streamingToolSender.resultFor(call.id);
        if (streamedResult) {
          return {
            role: "tool" as const,
            toolCallId: call.id,
            name: call.function.name,
            content: formatToolResultForLLM(streamedResult)
          };
        }
        const plugin = toolMap.get(call.function.name);
        let toolResult: ToolResult;
        if (!plugin) {
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

        return {
          role: "tool" as const,
          toolCallId: call.id,
          name: call.function.name,
          content: formatToolResultForLLM(toolResult)
        };
      }));

      nextInput = {
        ...nextInput,
        messages: [
          ...nextInput.messages,
          {
            role: "assistant",
            content: result.message.content,
            toolCalls: calls
          },
          ...toolMessages
        ]
      };
    }

    return deps.llm.chat(nextInput);
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
        if (state.canStreamNow()) state.dropPendingLines();
        if (lines.length === 0) return;
        const callId = state.callId;
        const plugin = toolMap.get("send_message");
        if (!callId || !plugin || state.toolName !== "send_message") return;
        sendChain = sendChain.then(async () => {
          for (const line of lines) {
            const sentCount = sentCounts.get(callId) ?? 0;
            if (sentCount > 0) await delay(500);
            await sendStreamingLine(plugin, event, callId, line, resultsByCallId);
            sentCounts.set(callId, sentCount + 1);
          }
        });
      },
      async finish() {
        for (const state of states.values()) {
          const lines = state.finish();
          const callId = state.callId;
          const plugin = toolMap.get("send_message");
          if (!callId || !plugin || state.toolName !== "send_message" || !state.shouldSendAsMessage()) continue;
          sendChain = sendChain.then(async () => {
            for (const line of lines) {
              const sentCount = sentCounts.get(callId) ?? 0;
              if (sentCount > 0) await delay(500);
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
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatToolResultForLLM(result: ToolResult): string {
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
      toolName: "send_message",
      input: { type: "message", content: line },
      requester: event.source,
      session: event.session
    });
    const output = formatToolResultForLLM(result);
    resultsByCallId.set(callId, {
      callId,
      ok: previous?.ok === false ? false : result.ok,
      output: [previousOutput, output].filter(Boolean).join("\n"),
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
}

function decodeJsonEscape(char: string): string {
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";
  if (char === "b") return "\b";
  if (char === "f") return "\f";
  return char;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
