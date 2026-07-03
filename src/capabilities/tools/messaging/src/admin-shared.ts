import { formatToolResultForLLM as renderToolResultForLLM, type LLMTextRenderer } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import { optionalString } from "../../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../../apps/api/bootstrap/admin-route-context.js";

export function getAdminTextRenderer(context: AdminRoutesContext): LLMTextRenderer {
  return context.getPromptRenderer();
}

export function resolveAdminMessagingTarget(context: AdminRoutesContext, plugin: "feishu" | "wechat") {
  if (plugin === "wechat") {
    const contact = context.wechatStateStore.listContacts()[0];
    if (!contact) return undefined;
    return {
      plugin: "wechat",
      accountId: "main",
      channelId: contact.userId,
      userId: contact.userId,
      sessionId: contact.sessionId
    };
  }
  return resolveFeishuTestTarget(context, {});
}

export function resolveFeishuTestTarget(context: AdminRoutesContext, body: Record<string, unknown>) {
  const channelId = optionalString(body.channelId);
  const userId = optionalString(body.userId);
  const firstContact = context.feishuPairingStore.list()[0];
  const receiveChannelId = channelId ?? firstContact?.channelId;
  const receiveUserId = receiveChannelId ? undefined : userId ?? firstContact?.userId;
  const sessionId = optionalString(body.sessionId) ?? firstContact?.sessionId ?? "admin-test";
  if (!receiveChannelId && !receiveUserId) return undefined;
  return { plugin: "feishu", accountId: "main", channelId: receiveChannelId, userId: receiveUserId, sessionId };
}

export function formatToolResultForLLM(result: { ok: boolean; output?: unknown; error?: string }, renderer: LLMTextRenderer): string {
  return renderToolResultForLLM(result, renderer);
}
