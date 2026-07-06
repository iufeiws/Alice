import type { BashSandboxConfig } from "./config.js";
import { isAllowedCwd } from "./paths.js";

export type BashPermissionDecision =
  | { state: "allow"; matchedRule: string; skillId?: string }
  | { state: "deny"; matchedRule: string; reason: string; skillId?: string };

type BashPermissionInput = {
  command: string;
  cwd: string;
  config: BashSandboxConfig;
  skillId?: string;
};

export function classifyBashCommand(input: BashPermissionInput): BashPermissionDecision {
  const command = input.command.trim();
  if (!command) return deny("empty_command", "command is required", input.skillId);
  if (!isAllowedCwd(input.config, input.cwd)) return deny("cwd_outside_sandbox", `cwd is outside configured sandbox paths: ${input.cwd}`, input.skillId);
  return { state: "allow", matchedRule: "sandbox_boundary", skillId: input.skillId };
}

function deny(matchedRule: string, reason: string, skillId?: string): BashPermissionDecision {
  return { state: "deny", matchedRule, reason, skillId };
}
