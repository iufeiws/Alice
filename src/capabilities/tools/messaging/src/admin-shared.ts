import { optionalString } from "../../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../../apps/api/bootstrap/admin-route-context.js";
import type { PromptContextRuntime } from "../../../../contexts/prompt-context/src/index.js";

export function getAdminTextRenderer(context: AdminRoutesContext): PromptContextRuntime {
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
  const accountId = optionalString(body.accountId);
  const firstContact = context.feishuPairingStore.list()[0];
  const receiveChannelId = channelId ?? firstContact?.channelId;
  const receiveUserId = receiveChannelId ? undefined : userId ?? firstContact?.userId;
  const sessionId = optionalString(body.sessionId) ?? firstContact?.sessionId ?? "admin-test";
  if (!receiveChannelId && !receiveUserId) return undefined;
  return { plugin: "feishu", accountId: accountId ?? firstContact?.accountId ?? "main", channelId: receiveChannelId, userId: receiveUserId, sessionId };
}

export function formatToolMessageContent(result: { ok: boolean; output?: unknown; error?: string }, renderer: PromptContextRuntime): string {
  if (!result.ok && typeof result.output === "string") return renderer.renderText(result.output);
  if (!result.ok) return result.error ? `error: ${renderer.renderText(result.error)}` : "error";
  if (typeof result.output === "string") return renderer.renderText(result.output);
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  return JSON.stringify(result.output);
}
