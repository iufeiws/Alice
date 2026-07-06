import fs from "node:fs";
import path from "node:path";
import type { MessagingPluginConfig } from "./types.js";

export const defaultMessagingPluginConfigPath = "config/plugin/messaging/config.json";

export function readMessagingPluginConfig(configPath = defaultMessagingPluginConfigPath): MessagingPluginConfig {
  const resolved = path.resolve(configPath);
  const parsed = parseJsonObject(fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}");
  return normalizeMessagingPluginConfig(parsed);
}

export function normalizeMessagingPluginConfig(parsed: Record<string, unknown>): MessagingPluginConfig {
  return {
    splitMultilineSendChat: booleanValue(parsed.splitMultilineSendChat, true, "splitMultilineSendChat"),
    limitConsecutiveSends: booleanValue(parsed.limitConsecutiveSends, true, "limitConsecutiveSends"),
    feishuTypingEmojiEnabled: booleanValue(parsed.feishuTypingEmojiEnabled, true, "feishuTypingEmojiEnabled")
  };
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid messaging plugin config JSON");
  return parsed as Record<string, unknown>;
}

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`invalid ${field}: ${String(value)}`);
}
