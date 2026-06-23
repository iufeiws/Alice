import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import type { ToolDefinition } from "../../../agent-loop/src/contracts/agent-contracts.js";
import {
  buildAppendPromptMessagesWithToolResults,
  buildPromptMessagesWithToolResults,
  makePromptContext,
  promptVariables
} from "./build-system-prompt.js";
import { memoryToolDefinitions } from "../../../memory/src/memory.js";
import { buildCalendarContext } from "../../../../capabilities/tools/calendar/src/index.js";

export function createPromptToolPreviewRuntime(input: {
  time: CurrentTimeProvider;
  dailyShellStore: any;
  coreProfileStore: any;
  getLibrarySetting?(): string;
  memoryStore: any;
  diaryStore: any;
  calendarStore: any;
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
    const variables = promptVariables(profile, makePreviewPromptContext(profile, previewEvent()));
    return input.llmRequests.buildTools(visibleToolNames(profile), variables);
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
    return memoryToolDefinitions().find((tool) => tool.name === name);
  }

  async function buildPromptPreviewMessages(
    profile: any,
    event: Parameters<typeof buildPromptMessagesWithToolResults>[1]["event"],
    includeFakeCheckChat = false
  ): Promise<LLMChatInput["messages"]> {
    const context = makePreviewPromptContext(profile, event);
    const runPreviewTool = async (_layer: unknown, call: any) => {
      if (call.toolName === "send_chat" || call.toolName === "send_feishu" || call.toolName === "send_wechat") {
        return {
          callId: call.id,
          ok: false,
          error: "send_chat cannot run from request preview"
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
    const messages = await buildPromptMessagesWithToolResults(profile, context, runPreviewTool as any);
    if (!includeFakeCheckChat) return messages;
    const appendMessages = await buildAppendPromptMessagesWithToolResults(profile, context, runPreviewTool as any);
    return [
      ...messages,
      ...appendMessages
    ];
  }

  function makePreviewPromptContext(profile: any, event: Parameters<typeof buildPromptMessagesWithToolResults>[1]["event"]) {
    return makePromptContext({
      event,
      time: input.time,
      getDailyShell: () => input.dailyShellStore.render(input.time.now().date, input.time.timeZone),
      getDailyShellRaw: () => input.dailyShellStore.get(input.time.now().date, input.time.timeZone),
      getAppearanceDescription: () => input.coreProfileStore.get().appearanceDescription,
      getLibrarySetting: () => input.getLibrarySetting?.() ?? input.coreProfileStore.get().librarySetting,
      getMemorySnapshot: () => input.memoryStore.read(),
      getWakeBoundary: () => input.diaryStore.latestWakeBoundary(),
      getCalendarContext: () => buildCalendarContext({
        calendarStore: input.calendarStore,
        time: input.time,
        userName: profile.userName
      }),
      preview: true
    });
  }

  function previewEvent(): Parameters<typeof buildPromptMessagesWithToolResults>[1]["event"] {
    const now = input.time.now();
    return {
      id: "tool_preview",
      source: { plugin: "preview", channelId: "preview", userId: "preview" },
      externalSession: { scope: "dm", sessionId: "preview" },
      type: "message.text",
      payload: { kind: "text", text: "" },
      meta: { receivedAt: now.iso, receivedAtUtc: now.date.toISOString() }
    };
  }
}
