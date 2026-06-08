import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import type { LLMChatInput } from "./index.js";
import { buildRawLLMRequest } from "./llm-request-shape.js";
import type { LLMRequestLogEntry, LLMRequestPreview } from "../../../core/session/index.js";
import type { LLMApiPreset } from "./llm-api-profile.js";

export function createLLMRequestPreviewRuntime(input: {
  requestLogs: LLMRequestLogEntry[];
  hasActiveSession(): boolean;
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
    getLLMRequestProfilePreview,
    getTalkLLMRequestProfilePreview
  };

  async function getLLMRequestPreview(): Promise<LLMRequestPreview | undefined> {
    const latest = input.requestLogs[input.requestLogs.length - 1];
    if (input.hasActiveSession() && latest) return { ...latest, source: "actual" };

    const preview = await buildLLMRequestPreviewFromMessages();
    if (preview) return { ...preview, rawRequest: buildRawLLMRequest(preview) };

    if (latest) return { ...latest, source: "actual" };
    return undefined;
  }

  async function getLLMRequestProfilePreview(apiPreset?: { model?: string; temperature?: number; extraParams?: Record<string, unknown> }): Promise<LLMRequestPreview | undefined> {
    const profilePreview = await buildLLMRequestPreviewFromProfile(apiPreset);
    return profilePreview ? { ...profilePreview, rawRequest: buildRawLLMRequest(profilePreview) } : undefined;
  }

  async function getTalkLLMRequestProfilePreview(apiPreset?: { model?: string; temperature?: number; extraParams?: Record<string, unknown> }): Promise<LLMRequestPreview | undefined> {
    const profilePreview = await buildLLMRequestPreviewFromProfile(apiPreset, input.getTalkPromptProfile());
    return profilePreview ? { ...profilePreview, rawRequest: buildRawLLMRequest(profilePreview) } : undefined;
  }

  async function buildLLMRequestPreviewFromProfile(
    apiPreset?: { model?: string; temperature?: number; extraParams?: Record<string, unknown> },
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
      session: {
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
    return {
      id: 0,
      source: "preview",
      conversationId: target?.sessionId ?? "preview",
      time: previewTime.iso,
      model: apiPreset?.model,
      temperature: apiPreset?.temperature,
      extraParams: apiPreset?.extraParams ?? {},
      messages: await input.buildPromptPreviewMessages(profile, previewEvent, true),
      tools: input.visibleToolSpecs(profile)
    };
  }

  async function buildLLMRequestPreviewFromMessages(): Promise<LLMRequestPreview | undefined> {
    const recent = input.listRecentMessages();
    const latestInbound = [...recent].reverse().find((message) => (
      message.direction === "inbound" &&
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
      session: {
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

    return {
      id: 0,
      source: "preview",
      conversationId: latestInbound.conversationId,
      time: latestInbound.lastEventAt || latestInbound.createdAt,
      model: chatPreset?.model,
      temperature: chatPreset?.temperature,
      extraParams: chatPreset?.extraParams ?? {},
      messages: await input.buildPromptPreviewMessages(profile, previewEvent, true),
      tools: input.visibleToolSpecs(profile)
    };
  }
}
