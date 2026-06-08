import type { FeishuOutboundClient, FeishuSendPlan } from "./types.js";

export function createConsoleFeishuOutboundClient(): FeishuOutboundClient {
  return {
    async send(plan: FeishuSendPlan) {
      console.log("[feishu:send]", JSON.stringify(plan));
    }
  };
}
