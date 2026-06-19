import { buildLLMTextVariables, formatToolResultForLLM as renderToolResultForLLM, type LLMTextVariables } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import { optionalString } from "../../../../shared/admin-input/src/index.js";
import { resolveLibrarySetting } from "../../../../contexts/world-wanderer/src/admin-library-setting.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../../apps/api/bootstrap/admin-route-context.js";

export function getAdminTextVariables(
  context: AdminRoutesContext,
  target: { plugin: string; accountId?: string; channelId?: string; userId?: string; sessionId: string }
): LLMTextVariables {
  const receivedTime = context.time.now();
  return buildLLMTextVariables({
    userName: context.promptProfileStore.get().userName,
    time: context.time,
    dailyShell: context.getDailyShell(),
    dailyShellRaw: context.dailyShellStore.get(context.time.now().date, context.time.timeZone),
    appearanceDescription: context.coreProfileStore.get().appearanceDescription,
    librarySetting: resolveLibrarySetting(context),
    event: {
      id: "admin_tool_preview",
      source: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      externalSession: {
        scope: "dm",
        sessionId: target.sessionId
      },
      type: "message.text",
      payload: { kind: "text", text: "" },
      meta: { receivedAt: receivedTime.iso, receivedAtUtc: receivedTime.date.toISOString() }
    }
  });
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

export function formatToolResultForLLM(result: { ok: boolean; output?: unknown; error?: string }, variables: LLMTextVariables = {}): string {
  return renderToolResultForLLM(result, variables);
}
