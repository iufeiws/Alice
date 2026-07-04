# Tool Agent Bash Sandbox and Skills Plan

## Goal

Add a non-interactive Bash tool runtime that executes agent shell commands only inside a fixed Docker sandbox, and add a Skills registry/loader so the agent can discover Skills and call Skill scripts through that Bash tool.

The runtime must never ask the user during Bash execution. A command is either allowed inside the configured sandbox or denied with a deterministic reason.

## Confirmed Behavior

- Bash commands do not run on the host shell.
- The host runtime only schedules work into a fixed Docker container.
- Permission decisions are `allow` or `deny`; there is no `ask`.
- Skills are visible to the container as read-only resources.
- Skill scripts are called through the same Bash tool, not registered as separate tools.
- The agent does not choose host mount paths.
- The agent does not assume the host project, output, cache, or data directories are mounted.
- Optional mounts are configured before runtime start and are not expanded by tool calls.
- Global deny rules override Skill-specific allow rules.
- No hidden prompt text is added by this feature.
- No legacy fallback path executes denied or failed commands on the host.

## Non-Goals

- Do not reproduce Claude Code internals.
- Do not add per-script function tools for every Skill script.
- Do not add wrapper commands around Skill scripts.
- Do not implement command-by-command user approval.
- Do not mount the host project directory by default.
- Do not expose Docker socket, host network, privileged mode, host pid, or host ipc.
- Do not treat Skill scripts as trusted code that bypasses sandbox policy.

## Current Codebase Context

- Tool execution already flows through `ToolPlugin` and `agent-loop-tool-executor`.
- `src/capabilities/skills/README.md` says Skills are present but not currently loaded or executed by runtime.
- `AppConfig` already has `skills.root`.
- `createToolRuntime()` wires the currently exposed tool plugins.

So the first implementation should add one new Bash tool plugin adapter, one context-owned Bash sandbox runtime, and one independent Skills runtime. It should not special-case the function-call loop.

## Target Architecture

```text
agent function-call loop
  -> ToolPlugin: bash
  -> context: bash-sandbox
       |-- Bash permission gate
       |-- Docker bash executor
       |-- sandbox workspace/import/export
  -> fixed container workspace
       |-- writable workspace/tmp/cache configured by runtime
       |-- read-only skills root
       |-- optional configured mounts
```

Skills discovery is separate from execution:

```text
context: skills
  -> Skill registry metadata
  -> model sees available skill name/description
  -> triggered skill loads full Skill instructions
  -> skill resource paths resolve to configured Bash sandbox container paths
  -> agent calls Skill scripts via bash command
  -> bash permission gate still applies
```

## Proposed Files

Add:

```text
src/capabilities/tools/bash/
  profile.ts
  src/index.ts

src/contexts/bash-sandbox/src/
  index.ts
  config.ts
  bash-runtime.ts
  workspace-runtime.ts
  docker-executor.ts
  permission.ts
  audit.ts
  paths.ts

src/contexts/skills/src/
  index.ts
  registry.ts
  loader.ts
  placeholders.ts
  resource-paths.ts
```

`src/capabilities/skills/` remains a Skill resource location. Runtime code should not live under that resource tree.

Wire from existing runtime:

```text
src/apps/api/bootstrap/app-config-runtime.ts
src/apps/api/bootstrap/api-capabilities-runtime.ts
src/capabilities/tools/messaging/src/tool-runtime.ts
```

Use existing `ToolPlugin` shape. The Bash tool delegates to `bash-sandbox`; it does not own Docker, mounts, permissions, workspace import/export, or Skill loading. Other tools stay controlled by their own tool plugins and do not need Bash sandboxing.

## Config Shape

Extend app config with a `bashSandbox` section:

```ts
type BashSandboxConfig = {
  enabled: boolean;
  containerName: string;
  image: string;
  defaultCwd: string;
  workspaceDir: string;
  tmpDir: string;
  skillsMount: { hostPath: string; containerPath: string; readOnly: true };
  mounts: Array<{
    id: string;
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
  }>;
  network: "none" | "configured";
  timeoutMs: number;
  outputLimitBytes: number;
  cpuLimit?: string;
  memoryLimit?: string;
  pidsLimit?: number;
  auditLogPath: string;
};
```

Defaults:

- `enabled: false` until explicitly configured.
- `network: "none"`.
- Skills mount is read-only.
- Optional mounts default read-only.
- No host project mount by default.

## Bash Tool API

Expose one tool, tentatively `bash`:

```json
{
  "command": "string",
  "cwd": "string optional",
  "timeoutMs": "number optional",
  "reason": "string optional"
}
```

Return:

```json
{
  "command": "string",
  "cwd": "string",
  "stdout": "string",
  "stderr": "string",
  "exitCode": "number nullable",
  "timedOut": "boolean",
  "durationMs": "number",
  "truncated": "boolean",
  "denied": "boolean",
  "denyReason": "string optional"
}
```

## Permission Gate

Implement permission as deterministic classification:

```text
global deny > skill-specific allow > global allow > default deny
```

Global deny covers:

- Docker socket or Docker daemon access.
- privileged, host network, host pid, host ipc, bind mount attempts.
- writes to read-only Skills mount.
- attempts to modify runtime config.
- access to sensitive host paths or credential file names.
- long-running detached background processes.
- obvious fork bombs or resource exhaustion.
- network tools when configured network is `none`.
- encoded or heavily indirect command forms that policy cannot inspect.

Global allow covers ordinary container-local work:

- reads and writes inside workspace/tmp/cache.
- tests and builds.
- local scripts and interpreters.
- Skill scripts under read-only Skills root.
- package installs only into configured workspace/cache locations.

If classification is uncertain, deny.

## Docker Executor

Use Docker only from `src/contexts/bash-sandbox`, never from the Bash tool adapter or the agent command itself.

Executor responsibilities:

- Ensure the fixed container exists and is running.
- Execute with configured user, cwd, environment, timeout, and output limits.
- Kill the process group on timeout.
- Return stdout/stderr/exit code without throwing for normal command failures.
- Restart the container only for container-level failures, according to config.
- Never pass host environment variables through wholesale.

Container setup requirements:

- no Docker socket;
- no privileged mode;
- no host namespace flags;
- network disabled by default;
- read-only root filesystem when practical;
- explicit writable workspace/tmp/cache;
- CPU, memory, and pid limits.

## Skills Registry and Loader

Registry:

- scan configured `skills.root`;
- read lightweight metadata only at startup;
- expose skill name, description, and resource root mapping;
- do not put every Skill file or script into model context.

Loader:

- load full Skill instructions only when triggered;
- resolve script/resource references to container paths;
- keep host paths out of agent-visible instructions;
- make missing files a clear error;
- never rewrite instructions by adding hidden prompt text.

Script execution:

- Skill instructions describe how to call scripts.
- The agent calls scripts with the `bash` tool.
- The Bash tool calls `bash-sandbox`, and `bash-sandbox` applies the same permission gate before Docker execution.
- Scripts read inputs from container workspace or configured mounts.
- Scripts write outputs to workspace/stdout/stderr.
- Export back to host is handled by runtime export policy, not arbitrary host writes.

## Import and Export

Add runtime-owned helpers after the first Bash tool works:

- import user-selected files into the sandbox workspace;
- export configured workspace outputs to configured host destinations;
- audit every import/export;
- deny arbitrary host path writes from Bash.

Do not block Bash execution waiting for import/export approval. Any user file choice happens before the Bash tool call.

## Audit

Write one structured audit event per Bash call:

- command, cwd, caller, tool call id;
- permission result and matched rule;
- Skill id if applicable;
- optional mount access if detected;
- network policy state;
- duration, exit code, timeout;
- stdout/stderr truncation metadata;
- denial reason.

Audit is for debugging and security review only. It is not an approval mechanism.

## Implementation Phases

1. Config and types
   - Add `bashSandbox` config.
   - Validate mounts at startup.
   - Reject sensitive host paths and writable Skills mounts.

2. Docker executor
   - Add `src/contexts/bash-sandbox`.
   - Add fixed-container exec wrapper.
   - Enforce timeout and output truncation.
   - Add minimal integration tests with a known local image or skipped test when Docker is unavailable.

3. Permission gate
   - Add allow/deny classifier.
   - Start conservative: default deny, explicit workspace/Skill allow, hard global denies.
   - Add unit tests for deny precedence and uncertain commands.

4. Bash ToolPlugin
   - Add `bash` tool.
   - Keep it as a thin adapter to `bash-sandbox`.
   - Wire it through `createToolRuntime()`.
   - Return denied results as tool results, not thrown exceptions.

5. Skills registry and loader
   - Implement under `src/contexts/skills`.
   - Scan Skill metadata from configured Skill resource roots.
   - Load full Skill instructions on demand.
   - Map Skill resource paths to container paths.
   - Keep scripts executable only via `bash`.

6. Import/export and audit
   - Add structured audit logging.
   - Add explicit import/export helpers if real workflows need host file exchange.

## Tests

- `bash` does not execute when `bashSandbox.enabled` is false.
- Allowed workspace command runs in Docker and returns stdout/stderr/exit code.
- Non-zero command exit returns `ok: true` tool execution with `exitCode`, not a thrown runtime error.
- Timeout kills the command and reports `timedOut: true`.
- Output longer than limit is truncated and marked.
- `cwd` outside configured container paths is denied.
- Docker socket access is denied.
- privileged/host namespace/mount attempts are denied.
- network command is denied when network is `none`.
- write attempt under Skills mount is denied.
- Skill-specific allow cannot override global deny.
- Unknown or unparseable high-risk command is denied.
- Skills registry loads metadata without loading all scripts into context.
- Skill loader resolves script paths to container paths, not host paths.
- Missing Skill script returns clear error.
- Optional mount config rejects sensitive host paths.
- Audit event is written for allow, deny, timeout, and truncation cases.

## Acceptance

- Agent Bash commands never run in the host shell.
- All allowed Bash commands execute in the fixed Docker sandbox.
- Runtime never asks the user during Bash command execution.
- Permission state is only `allow` or `deny`.
- Skills can be discovered and used.
- Skill scripts execute through the Bash tool inside Docker.
- The sandbox has no default host project mount.
- The sandbox has no default host sensitive directory access.
- The Skills root is read-only.
- Global deny rules always win.
- Results are auditable.
- Unsafe or uncertain commands are denied instead of escalated to user approval.

## Open Questions

- Which Docker image should be the first supported sandbox image?
- Should `bashSandbox.enabled` be controlled only by config file/env, or also by admin UI?
- Which host directory, if any, should be the first writable export target?
- Should the first version expose Skill metadata to the LLM through prompt profile text, or only through a dedicated tool result?

## Skipped

- Per-script tools are skipped because the requirement says Skill scripts should stay ordinary files called through Bash.
- Host project auto-mount is skipped because the requirement explicitly rejects default host directory assumptions.
- User approval flow is skipped because the requirement requires non-interactive execution.
