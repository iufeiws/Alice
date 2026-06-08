import type { CurrentTimeProvider } from "../../../../core/time/src/index.js";
import type { LLMChatInput } from "../../../../core/llm/src/index.js";
import type { ToolDefinition } from "../../../../packages/types/src/index.js";
import {
  buildAppendPromptMessagesWithToolResults,
  buildPromptMessagesWithToolResults
} from "../../../../core/agent/src/prompts.js";
import { buildLLMTextVariables } from "../../../../core/text-renderer/src/index.js";
import { memoryToolDefinitions } from "../../../../core/agent/src/memory.js";

export function createPromptToolPreviewRuntime(input: {
  time: CurrentTimeProvider;
  dailyShellStore: any;
  coreProfileStore: any;
  memoryStore: any;
  diaryStore: any;
  toolPlugins: any[];
  llmRequests: { buildTools(names: string[], variables: unknown): LLMChatInput["tools"] };
  messagingTools: { execute(call: any): Promise<unknown> | unknown };
}) {
  return {
    visibleToolSpecs,
    visibleToolNames,
    getLLMRequestToolDefinition,
    buildPromptPreviewMessages
  };

  function visibleToolSpecs(profile: any): LLMChatInput["tools"] {
    const variables = buildLLMTextVariables({
      userName: profile.userName,
      time: input.time,
      dailyShell: input.dailyShellStore.render(input.time.now().date, input.time.timeZone),
      dailyShellRaw: input.dailyShellStore.get(input.time.now().date, input.time.timeZone),
      appearanceDescription: input.coreProfileStore.get().appearanceDescription,
      memory: input.memoryStore.read()
    });
    return input.llmRequests.buildTools(visibleToolNames(profile), variables);
  }

  function visibleToolNames(profile: any): string[] {
    return input.toolPlugins
      .filter((plugin) => {
        if (plugin.id === "messaging") return profile.visibleTools.feishu !== false;
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
    return memoryToolDefinitions().find((tool) => tool.name === name);
  }

  async function buildPromptPreviewMessages(
    profile: any,
    event: Parameters<typeof buildPromptMessagesWithToolResults>[1]["event"],
    includeFakeCheckChat = false
  ): Promise<LLMChatInput["messages"]> {
    const context = {
      event,
      time: input.time,
      dailyShell: input.dailyShellStore.render(input.time.now().date, input.time.timeZone),
      dailyShellRaw: input.dailyShellStore.get(input.time.now().date, input.time.timeZone),
      appearanceDescription: input.coreProfileStore.get().appearanceDescription,
      memory: input.memoryStore.read(),
      wakeBoundary: input.diaryStore.latestWakeBoundary()
    };
    const runPreviewTool = async (_layer: unknown, call: any) => {
      if (call.toolName === "send_chat" || call.toolName === "send_feishu" || call.toolName === "send_wechat") {
        return {
          callId: call.id,
          ok: false,
          error: "send_chat cannot run from request preview"
        };
      }
      try {
        return await input.messagingTools.execute({
          ...call,
          input: { ...call.input, __preview: true }
        });
      } catch (error) {
        return {
          callId: call.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    };
    const messages = await buildPromptMessagesWithToolResults(profile, context, runPreviewTool as any);
    if (!includeFakeCheckChat) return messages;
    const appendMessages = await buildAppendPromptMessagesWithToolResults(profile, context, runPreviewTool as any);
    return [
      ...messages,
      ...appendMessages
    ];
  }
}
