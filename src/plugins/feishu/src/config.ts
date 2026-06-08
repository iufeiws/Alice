import type { FeishuConfig } from "./types.js";

export function isFeishuConfigured(config: FeishuConfig): boolean {
  return config.enabled && Object.keys(config.accounts).length > 0;
}
