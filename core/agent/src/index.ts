import type { AppConfig } from "../../../packages/config/src/index.js";
import type { LLMClient } from "../../llm/src/index.js";
import type { OutputRouter } from "../../output-router/src/index.js";
import type { PolicyEngine } from "../../policy/src/index.js";
import type { IntentRouter } from "../../router/src/index.js";
import type { SessionResolver } from "../../session/src/index.js";
import type { AgentEvent, AgentOutput, ChannelPlugin } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import { getPromptContent } from "./prompts.js";

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
};

export interface AgentCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleEvent(event: AgentEvent): Promise<AgentOutput[]>;
  registerChannel(plugin: ChannelPlugin): void;
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const channels: ChannelPlugin[] = [];

  return {
    async start() {
      await Promise.all(channels.map((channel) => channel.start()));
    },
    async stop() {
      await Promise.all([...channels].reverse().map((channel) => channel.stop()));
    },
    registerChannel(plugin) {
      channels.push(plugin);
      deps.outputRouter.register(plugin);
    },
    async handleEvent(event) {
      const decision = await deps.policy.check(event);
      if (!decision.allowed) {
        return [
          buildReply(event, {
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
        return [buildReply(event, { kind: "text", text: routed.reason })];
      }

      if (routed.kind === "codex") {
        return [
          buildReply(event, {
            kind: "markdown",
            markdown: `Codex command accepted by router, but Codex worker is not implemented yet.\n\nPrompt: ${routed.prompt || "(empty)"}`
          })
        ];
      }

      const recalled = await deps.memory?.recall(event) ?? [];
      const llmResult = await deps.llm.chat({
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
      });

      const outputs = [
        buildReply(event, {
          kind: "text",
          text: llmResult.message.content || `Echo: ${routed.text}`
        })
      ];
      await deps.memory?.capture(event, outputs);
      return outputs;
    }
  };
}

function buildReply(
  event: AgentEvent,
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
      createdAt: new Date().toISOString(),
      urgency: "normal",
      allowStreaming: false
    }
  };
}
