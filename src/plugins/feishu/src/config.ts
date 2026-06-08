import type { FeishuConfig } from "../../../packages/config/src/index.js";

export function isFeishuConfigured(config: FeishuConfig): boolean {
  return config.enabled && Object.keys(config.accounts).length > 0;
}
