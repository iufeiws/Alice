import type { BashSandboxConfig } from "./config.js";
import { commandMentionsPath, isAllowedCwd, isReadOnlyPath, normalizeContainerPath } from "./paths.js";

export type BashPermissionDecision =
  | { state: "allow"; matchedRule: string; skillId?: string }
  | { state: "deny"; matchedRule: string; reason: string; skillId?: string };

export type BashPermissionInput = {
  command: string;
  cwd: string;
  config: BashSandboxConfig;
  skillId?: string;
};

export function classifyBashCommand(input: BashPermissionInput): BashPermissionDecision {
  const command = input.command.trim();
  if (!command) return deny("empty_command", "command is required", input.skillId);
  if (!isAllowedCwd(input.config, input.cwd)) return deny("cwd_outside_sandbox", `cwd is outside configured sandbox paths: ${input.cwd}`, input.skillId);

  const globalDeny = classifyGlobalDeny(command, input);
  if (globalDeny) return globalDeny;

  if (input.skillId && input.config.skillMounts.some((mount) => commandMentionsPath(command, mount.containerPath))) {
    return { state: "allow", matchedRule: "skill_script", skillId: input.skillId };
  }
  if (isOrdinaryLocalCommand(command)) return { state: "allow", matchedRule: "local_work" };
  return deny("default_deny", "command is not explicitly allowed", input.skillId);
}

function classifyGlobalDeny(command: string, input: BashPermissionInput): BashPermissionDecision | undefined {
  const lower = command.toLowerCase();
  if (/[;&|`$<>]/.test(command)) return deny("indirect_shell", "compound or indirect shell forms are not allowed", input.skillId);
  if (/^(?:bash|sh)\s+-[lc]/.test(lower)) return deny("indirect_shell", "nested shell command forms are not allowed", input.skillId);
  if (/\b(?:docker|podman|nerdctl|kubectl)\b/.test(lower)) return deny("container_daemon", "container daemon access is not allowed", input.skillId);
  if (/\b--(?:privileged|network=host|pid=host|ipc=host|mount|volume)\b|\s-[^-]*v/.test(lower)) return deny("host_escape_flag", "host namespace or bind mount flags are not allowed", input.skillId);
  if (/(?:^|\s)(?:curl|wget|ssh|scp|rsync|nc|ncat|telnet|ftp|dig|nslookup|ping)(?:\s|$)/.test(lower) && input.config.network === "none") {
    return deny("network_disabled", "network tools are denied because sandbox network is none", input.skillId);
  }
  if (/(?:^|\s)(?:nohup|setsid|disown)(?:\s|$)|&\s*$/.test(lower)) return deny("detached_process", "detached background processes are not allowed", input.skillId);
  if (/:\s*\(\s*\)\s*\{|\bfork\b|while\s+true|yes\s*(?:$|\s)/.test(lower)) return deny("resource_exhaustion", "resource exhaustion patterns are not allowed", input.skillId);
  if (/\b(?:base64|xxd|openssl)\b.*\b(?:-d|enc|base64)\b/.test(lower)) return deny("encoded_command", "encoded command forms are not allowed", input.skillId);
  if (/(^|[/\s])(?:\.ssh|\.aws|\.docker|id_rsa|id_ed25519|credentials|token)([/\s]|$)/i.test(command)) return deny("credential_path", "credential-like paths are not allowed", input.skillId);

  const executable = command.split(/\s+/, 1)[0];
  const writes = /^(?:rm|rmdir|mv|cp|touch|mkdir|tee|sed|perl|python|python3|node|npm|pnpm|yarn)$/.test(executable);
  const write = lower.match(/(?:^|\s)(?:rm|rmdir|mv|cp|touch|mkdir|tee|sed|perl|python|python3|node|npm|pnpm|yarn)\s+(.+)/);
  if (writes && isReadOnlyPath(input.config, input.cwd)) return deny("readonly_cwd", `read-only cwd cannot be modified: ${input.cwd}`, input.skillId);
  if (write && input.config.skillMounts.some((mount) => commandMentionsPath(command, mount.containerPath))) return deny("readonly_skills", "skills mounts are read-only", input.skillId);
  for (const token of command.split(/\s+/)) {
    const normalized = normalizeContainerPath(token, input.cwd);
    if (normalized && isReadOnlyPath(input.config, normalized) && /^(?:rm|rmdir|mv|cp|touch|mkdir|tee)$/.test(executable)) {
      return deny("readonly_mount", `read-only path cannot be modified: ${normalized}`, input.skillId);
    }
  }
  if (/bashsandbox|bash-sandbox|auditlog|audit_log|config\.json/i.test(command)) return deny("runtime_config", "runtime config modification is not allowed", input.skillId);
  return undefined;
}

function isOrdinaryLocalCommand(command: string): boolean {
  const executable = command.split(/\s+/, 1)[0];
  return /^(?:bash|sh|node|npm|pnpm|yarn|npx|python|python3|ruby|perl|deno|bun|go|cargo|make|cmake|git|rg|grep|find|ls|cat|pwd|printf|echo|test|\[|mkdir|touch|cp|mv|rm|tar|unzip|zip|sed|awk|sort|uniq|wc|head|tail)$/.test(executable);
}

function deny(matchedRule: string, reason: string, skillId?: string): BashPermissionDecision {
  return { state: "deny", matchedRule, reason, skillId };
}
