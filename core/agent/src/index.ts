import type { AppConfig } from "../../../packages/config/src/index.js";
import type { LLMChatInput, LLMClient } from "../../llm/src/index.js";
import type { OutputRouter } from "../../output-router/src/index.js";
import type { PolicyEngine } from "../../policy/src/index.js";
import type { IntentRouter } from "../../router/src/index.js";
import type { SessionResolver } from "../../session/src/index.js";
import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../time/src/index.js";
import type { AgentEvent, AgentOutput, ChannelPlugin } from "../../../packages/types/src/index.js";
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
          temperature: deps.config.llm.temperature
        } satisfies LLMChatInput;
        deps.onLLMRequestPrepared?.(llmInput);
        const llmResult = await deps.llm.chat(llmInput);

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
