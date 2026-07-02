# Agent Skill Integration Plan

## Goal

Implement CC-style project skills using the existing variable rendering and `ToolPlugin` execution path.

The model sees lightweight `<available_skills>` metadata from variables. It loads a skill by calling one `Skill` tool. The tool reads and renders `SKILL.md`, mounts the package into the sandbox after a successful load, and returns the loaded detail plus sandbox path as `function_call_output`.

## Confirmed Decisions

- First-party skills live under `src/capabilities/skills`.
- Installed third-party skills live under `.alice/skills`.
- This phase only provides the `available_skills` variable. It does not add prompt/profile text.
- The tool name is exactly `Skill`.
- Existing `list_skills` and `load_skill` were introduced by mistake and should be removed, with no compatibility fallback.
- Slash command support is not implemented in this phase.
- Skill packages are mounted read-write after `Skill` load, not at sandbox startup.
- `Skill` output must include the sandbox-visible skill path.
- Public skill installation is not implemented in this phase.
- Package limits are not implemented in this phase.
- Skill scripts run through Bash, so script execution audit remains in Bash audit.

## Current State

- `src/contexts/skills` already scans mounted skill roots and loads `SKILL.md`.
- `src/capabilities/tools/skills` currently exposes mistaken `list_skills` and `load_skill` tools.
- `src/contexts/bash-sandbox` currently assumes skill mounts are configured at startup.
- Agent tool calls already route through `ToolPlugin` and `agent-loop-tool-executor`.
- `buildLLMTextVariables()` is the existing variable source for prompt rendering.

## Non-Goals

- No path-triggered discovery.
- No fork subagent execution.
- No dynamic context injection.
- No script execution during skill load.
- No per-skill function tools.
- No user approval flow inside skill load.
- No host path exposure to the model.
- No prompt/history mutation after tool calls.
- No public skill installer in this phase.
- No slash command mapping in this phase.

## Design

```text
src/capabilities/skills + .alice/skills
  -> SkillRegistry
  -> available_skills variable

agent
  -> ToolPlugin: Skill({ skill, args? })
  -> SkillLoader
       |-- exact registry lookup
       |-- metadata/package validation
       |-- args rendering
       |-- dynamic sandbox mount
  -> function_call_output: <skill_result ...>
```

The implementation should reuse `src/contexts/skills` and replace the current two-tool adapter with one `Skill` tool.

## Skill Sources

Registry inputs:

- `src/capabilities/skills`: first-party skills.
- `.alice/skills`: installed third-party skills.

Both sources use the same package contract:

```text
<skill-package>/
  SKILL.md
  references/
  examples/
  assets/
  scripts/
```

Only `SKILL.md` is required. Host paths stay internal.

## Data Model

Extend `SkillMetadata` only as needed for this phase:

```ts
type SkillMetadata = {
  id: string;
  name: string;
  description: string;
  version?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  disabled?: boolean;
  unsupported?: "fork" | "dynamic-context";
  hostRoot: string;
  instructionPath: string;
  sandboxRoot?: string;
  source: "first-party" | "third-party";
};
```

`hostRoot` and `instructionPath` are internal only. Tool output and `available_skills` must not expose them.

## Available Skills Variable

Add a formatter in `src/contexts/skills`:

```xml
<available_skills>
  <skill>
    <name>fix-issue</name>
    <description>Fix a tracked issue by identifier.</description>
  </skill>
</available_skills>
```

Rules:

- Include only valid, enabled, model-invocable skills.
- Include only lightweight metadata.
- Do not include `SKILL.md` content.
- Do not include host paths or package storage details.
- Provide the variable only; do not add prompt/profile text in this phase.
- Registry changes affect future input construction only.

## Single Tool

Replace `list_skills` and `load_skill` with one tool:

```json
{
  "name": "Skill",
  "parameters": {
    "type": "object",
    "properties": {
      "skill": { "type": "string" },
      "args": { "type": "string" }
    },
    "required": ["skill"],
    "additionalProperties": false
  }
}
```

Execution rules:

- Use exact skill name lookup.
- Execute through normal `ToolPlugin.execute`.
- Return `SKILL_NOT_FOUND` for unknown names.
- Return `SKILL_DISABLED` for disabled skills.
- Return `SKILL_NOT_MODEL_INVOCABLE` for `disable-model-invocation: true`.
- Return `FORK_NOT_SUPPORTED` for `context: fork`.
- Return `DYNAMIC_CONTEXT_NOT_SUPPORTED` for dynamic context declarations.
- Do not mutate base prompt, history, or variable tree.

## Skill Load Output

On success, return XML-style tool output:

```xml
<skill_result status="loaded">
  <skill>
    <name>fix-issue</name>
    <mount>
      <skill_dir>/skills/fix-issue</skill_dir>
      <mode>read-write</mode>
    </mount>
  </skill>
  <loaded_skill name="fix-issue">
...
  </loaded_skill>
</skill_result>
```

Rules:

- `skill_dir` is the sandbox-visible path.
- `loaded_skill` contains rendered `SKILL.md`.
- Output is append-only tool result.
- Output does not expose host paths.
- Output does not rewrite `available_skills`.

## Args Rendering

`args` is raw input to the skill content loader.

Support:

```text
$ARGUMENTS
$0
$1
$2
$ARGUMENTS[0]
$ARGUMENTS[1]
$ARGUMENTS[2]
```

Rules:

- `$ARGUMENTS` is the original args string.
- Positional args use `shell-quote` parsing.
- If args are non-empty and no placeholder is used, append `ARGUMENTS: <args>` to rendered skill content.
- Args do not select read/run mode.

Use `shell-quote` only to split the raw args string. Do not execute, expand, or assign shell semantics from parsed tokens.

## Dynamic Sandbox Mount

Change the sandbox integration from startup skill mounts to load-time skill mounts:

```text
Skill loaded
  -> validate package root
  -> create sandbox-visible mount
  -> store mount in sandbox runtime state
  -> return sandbox path in tool output
```

Rules:

- Mount only after successful `Skill` load.
- Mount mode is `read-write`.
- Supporting files must be accessible to later sandbox tools.
- Scripts are not executed during load.
- The model only receives sandbox paths.
- Host paths stay inside runtime state.

## Implementation Steps

1. Skill source config
   - Add `.alice/skills` as third-party skill root.
   - Keep `src/capabilities/skills` as first-party skill root.
   - Build one registry from both roots.

2. Registry validation
   - Parse required `name` and `description`.
   - Parse optional `version`, `allowed-tools`, `disable-model-invocation`, `user-invocable`.
   - Detect unsupported `context: fork` and dynamic context declarations.
   - Reject invalid, disabled, duplicate, or path-escaping packages from `available_skills`.

3. Variable output
   - Add `formatAvailableSkillsXml(registry)`.
   - Wire it into existing variable assembly as `available_skills`.
   - Do not edit prompt/profile text.

4. Tool adapter
   - Delete `list_skills` and `load_skill`.
   - Add `Skill`.
   - Return spec error codes instead of thrown generic errors.

5. Loader
   - Render `SKILL.md`.
   - Render args placeholders with `shell-quote`.
   - Request dynamic sandbox mount.
   - Return `<skill_result>` with `skill_dir`.

6. Bash sandbox
   - Add runtime state for loaded skill mounts.
   - Stop exposing all skill roots at startup.
   - Keep path escape checks before mount.
   - Keep script execution under Bash audit.

## Tests

Add focused tests only:

- first-party skill appears in `available_skills`.
- third-party `.alice/skills` skill appears in `available_skills`.
- invalid or disabled skill does not appear.
- `Skill` exact-name lookup succeeds.
- old `list_skills` and `load_skill` are no longer exposed.
- unknown skill returns `SKILL_NOT_FOUND`.
- fork skill returns `FORK_NOT_SUPPORTED`.
- args placeholders render correctly with shell-like quoting.
- unused args append `ARGUMENTS: <args>`.
- tool output includes sandbox `skill_dir`.
- loaded skill mount is read-write.
- tool output contains no host path.
- skill load does not mutate variables or history.
- supporting file path escape is rejected before mount.

## Deferred Work

- Public skill installer.
- Package size and file-count limits.
- Slash command mapping.
- Skill install origin metadata.
- Registry signing, trust policy, and revocation.

## Acceptance

- `available_skills` exists as a variable and contains only lightweight metadata.
- The agent loads skill detail only through `Skill`.
- `list_skills` and `load_skill` are gone.
- A loaded skill is dynamically mounted and returns sandbox `skill_dir`.
- Tool load does not expose host paths and does not mutate prompt history or variables.

Skipped: installer, slash commands, and package limits. Add them when their behavior is confirmed.
