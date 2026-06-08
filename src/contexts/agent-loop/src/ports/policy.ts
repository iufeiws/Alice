import type { AgentEvent } from "../contracts/agent-contracts.js";

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

export interface PolicyEngine {
  check(event: AgentEvent): Promise<PolicyDecision>;
}

export function createAllowAllPolicy(): PolicyEngine {
  return {
    async check() {
      return { allowed: true };
    }
  };
}
