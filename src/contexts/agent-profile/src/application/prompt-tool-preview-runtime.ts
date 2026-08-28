import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import type { ToolDefinition } from "../../../tool-execution/src/index.js";
import {
  buildAppendPromptMessagesWithToolResults,
  buildPromptMessagesWithToolResults,
  type PromptRenderContext
} from "./build-system-prompt.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";

export function createPromptToolPreviewRuntime(input: {
  time: CurrentTimeProvider;
  getPromptRenderer(): PromptContextRuntime;
  toolPlugins: any[];
  llmRequests: { buildTools(names: string[], renderer: PromptContextRuntime): LLMChatInput["tools"] };
  messagingTools: { execute(call: any): Promise<unknown> | unknown };
}) {
  return {
    visibleToolSpecs,
    visibleToolNames,
    getLLMRequestToolDefinition,
    buildPromptPreviewMessages
  };

  function visibleToolSpecs(profile: any): LLMChatInput["tools"] {
    return input.llmRequests.buildTools(visibleToolNames(profile), input.getPromptRenderer());
  }

  function visibleToolNames(profile: any): string[] {
    return input.toolPlugins
      .filter((plugin) => {
        if (plugin.id === "messaging") return profile.visibleTools.feishu !== false;
        if (plugin.id === "finish-and-wait") return profile.visibleTools.feishu !== false;
        if (plugin.id === "photo") return profile.visibleTools.photo !== false && profile.visibleTools.media !== false;
        if (plugin.id === "shell") return profile.visibleTools.shell !== false;
        return true;
      })
      .flatMap((plugin) => plugin.listTools().map((tool: ToolDefinition) => tool.name));
  }

  function getLLMRequestToolDefinition(name: string): ToolDefinition | undefined {
    for (const plugin of input.toolPlugins) {
      const tool = plugin.listTools().find((entry: ToolDefinition) => entry.name === name);
      if (tool) return tool;
    }
    return undefined;
  }

  async function buildPromptPreviewMessages(
    profile: any,
    event: Parameters<typeof buildPromptMessagesWithToolResults>[1]["event"],
    includeFakeCheckChat = false
  ): Promise<LLMChatInput["messages"]> {
    const context = previewContext(event);
    const runPreviewTool = async (_layer: unknown, call: any) => {
      if (call.toolName === "Chat" && call.input?.action === "send") {
        return {
          callId: call.id,
          ok: false,
          error: "Chat send cannot run from request preview"
        };
      }
      const plugin = input.toolPlugins.find((candidate) => candidate.listTools().some((tool: ToolDefinition) => tool.name === call.toolName));
      if (!plugin) {
        return {
          callId: call.id,
          ok: false,
          error: `unknown tool: ${call.toolName}`
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
    };
    const messages = await buildPromptMessagesWithToolResults(profile, context, runPreviewTool as any, getLLMRequestToolDefinition);
    if (!includeFakeCheckChat) return messages;
    const appendMessages = await buildAppendPromptMessagesWithToolResults(profile, context, runPreviewTool as any, getLLMRequestToolDefinition);
    return [
      ...messages,
      ...appendMessages
    ];
  }

  function previewContext(event: PromptRenderContext["event"]): PromptRenderContext {
    return {
      renderer: input.getPromptRenderer(),
      event,
      time: input.time,
      preview: true
    };
  }

}
