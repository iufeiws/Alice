import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { LLMChatInput } from "./index.js";
import { buildRawLLMRequest } from "./llm-request-shape.js";
import type { LLMRequestLogEntry, LLMRequestPreview } from "../../../contexts/llm-session/src/index.js";
import { cloneLLMMessages } from "../../../contexts/llm-session/src/adapters/jsonl-llm-session-log.js";
import type { LLMApiPreset } from "./llm-api-profile.js";

export function createLLMRequestPreviewRuntime(input: {
  requestLogs: LLMRequestLogEntry[];
  getActiveSession(): {
    id: number;
    messages: LLMChatInput["messages"];
  } | undefined;
  listRecentMessages(): any[];
  getPromptProfile(): any;
  getTalkPromptProfile(): any;
  getDefaultTarget(): any;
  resolveChatPreset(): LLMApiPreset | undefined;
  time: CurrentTimeProvider;
  buildPromptPreviewMessages(profile: any, event: any, includeFakeCheckChat?: boolean): Promise<LLMChatInput["messages"]>;
  visibleToolSpecs(profile: any): LLMChatInput["tools"];
}) {
  return {
    getLLMRequestPreview,
    getLatestActualLLMRequestPreview,
    getLLMRequestProfilePreview,
    getTalkLLMRequestProfilePreview
  };

  async function getLLMRequestPreview(): Promise<LLMRequestPreview | undefined> {
    const actual = getLatestActualLLMRequestPreview();
    if (actual) return actual;

    const preview = await buildLLMRequestPreviewFromMessages();
    if (preview) return { ...preview, rawRequest: buildRawLLMRequest(preview) };

    return undefined;
  }

  function getLatestActualLLMRequestPreview(): LLMRequestPreview | undefined {
    const latest = input.requestLogs[input.requestLogs.length - 1];
    const session = input.getActiveSession();
    if (!latest || !session || String(latest.sessionId) !== String(session.id)) return undefined;
    const messageCount = Math.max(0, Math.min(session.messages.length, latest.messageCount));
    const preview: LLMRequestPreview = {
      ...latest,
      source: "actual",
      messages: cloneLLMMessages(session.messages.slice(0, messageCount))
    };
    return { ...preview, rawRequest: buildRawLLMRequest(preview) };
  }

  async function getLLMRequestProfilePreview(apiPreset?: { protocol?: LLMApiPreset["protocol"]; stream?: boolean; model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown> }): Promise<LLMRequestPreview | undefined> {
    const profilePreview = await buildLLMRequestPreviewFromProfile(apiPreset);
    return profilePreview ? { ...profilePreview, rawRequest: buildRawLLMRequest(profilePreview) } : undefined;
  }

  async function getTalkLLMRequestProfilePreview(apiPreset?: { protocol?: LLMApiPreset["protocol"]; stream?: boolean; model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown> }): Promise<LLMRequestPreview | undefined> {
    const profilePreview = await buildLLMRequestPreviewFromProfile(apiPreset, input.getTalkPromptProfile());
    return profilePreview ? { ...profilePreview, rawRequest: buildRawLLMRequest(profilePreview) } : undefined;
  }

  async function buildLLMRequestPreviewFromProfile(
    apiPreset?: { protocol?: LLMApiPreset["protocol"]; stream?: boolean; model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown> },
    profile = input.getPromptProfile()
  ): Promise<LLMRequestPreview | undefined> {
    const target = input.getDefaultTarget();
    const previewTime = input.time.now();
    const previewEvent = {
      id: "preview",
      source: {
        plugin: target?.plugin ?? "wechat",
        accountId: target?.accountId,
        channelId: target?.channelId ?? target?.userId ?? "preview",
        userId: target?.userId
      },
      externalSession: {
        scope: "dm",
        sessionId: target?.sessionId ?? "preview"
      },
      type: "message.text",
      payload: { kind: "text", text: "" },
      meta: {
        receivedAt: previewTime.iso,
        receivedAtUtc: previewTime.date.toISOString()
      }
    } as const;
    const messages = await input.buildPromptPreviewMessages(profile, previewEvent, true);
    return {
      id: 0,
      protocol: apiPreset?.protocol,
      stream: apiPreset?.stream,
      source: "preview",
      conversationId: target?.sessionId ?? "preview",
      time: previewTime.iso,
      model: apiPreset?.model,
      temperature: apiPreset?.temperature,
      maxTokens: apiPreset?.maxTokens,
      extraParams: apiPreset?.extraParams ?? {},
      messageCount: messages.length,
      messages,
      tools: input.visibleToolSpecs(profile)
    };
  }

  async function buildLLMRequestPreviewFromMessages(): Promise<LLMRequestPreview | undefined> {
    const recent = input.listRecentMessages();
    const latestInbound = [...recent].reverse().find((message) => (
      (message.direction === "inbound" || message.direction === "both") &&
      !message.isRecalled &&
      !message.isRead &&
      !message.coreProcessedAt
    ));
    if (!latestInbound) return undefined;

    const previewEvent = {
      id: `preview_${latestInbound.id}`,
      source: {
        plugin: latestInbound.plugin,
        channelId: latestInbound.conversationId,
        userId: latestInbound.senderId,
        rawMessageId: latestInbound.externalMessageId
      },
      externalSession: {
        scope: "dm",
        sessionId: latestInbound.conversationId
      },
      type: "message.text",
      payload: { kind: "text", text: "" },
      meta: {
        receivedAt: latestInbound.createdAt,
        replyTo: latestInbound.externalMessageId
      }
    } as const;
    const profile = input.getPromptProfile();
    const chatPreset = input.resolveChatPreset();

    const messages = await input.buildPromptPreviewMessages(profile, previewEvent, true);
    return {
      id: 0,
      protocol: chatPreset?.protocol,
      stream: chatPreset?.stream,
      source: "preview",
      conversationId: latestInbound.conversationId,
      time: latestInbound.lastEventAt || latestInbound.createdAt,
      model: chatPreset?.model,
      temperature: chatPreset?.temperature,
      maxTokens: chatPreset?.maxTokens,
      extraParams: chatPreset?.extraParams ?? {},
      messageCount: messages.length,
      messages,
      tools: input.visibleToolSpecs(profile)
    };
  }
}
