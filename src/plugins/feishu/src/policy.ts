import type { FeishuConfig } from "../../../packages/config/src/index.js";
import type { AgentEvent } from "../../../packages/types/src/index.js";

export function checkFeishuEventPolicy(config: FeishuConfig, event: AgentEvent): { allowed: boolean; reason?: string } {
  const userId = event.source.userId;
  const channelId = event.source.channelId;

  if (event.session.scope === "dm") {
    if (config.dmPolicy === "disabled") return { allowed: false, reason: "DM disabled" };
    if (config.dmPolicy === "open") return { allowed: true };
    if (config.dmPolicy === "allowlist") {
      return userId && config.dmAllowFrom.includes(userId)
        ? { allowed: true }
        : { allowed: false, reason: "DM user not allowlisted" };
    }
    return { allowed: true };
  }

  if (event.session.scope === "group") {
    if (config.groupPolicy === "disabled") return { allowed: false, reason: "Group disabled" };
    if (config.requireMention && !event.meta.mentionsBot) {
      return { allowed: false, reason: "Bot mention is required" };
    }
    if (config.groupPolicy === "open") return { allowed: true };
    return channelId && config.groupAllowFrom.includes(channelId)
      ? { allowed: true }
      : { allowed: false, reason: "Group not allowlisted" };
  }

  return { allowed: true };
}
