import type { PromptContextRuntime, PromptContextValue } from "../contracts/prompt-context-runtime.js";

export function promptVariableTree(runtime: PromptContextRuntime): Record<string, PromptContextValue> {
  const out: Record<string, PromptContextValue> = {};
  for (const name of runtime.listVariables()) setPath(out, name, runtime.getVariable(name));
  return out;
}

function setPath(target: Record<string, PromptContextValue>, path: string, value: PromptContextValue): void {
  const parts = path.split("/");
  let cursor: Record<string, PromptContextValue> = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) cursor[part] = {};
    cursor = cursor[part] as Record<string, PromptContextValue>;
  }
  cursor[parts.at(-1)!] = value;
}
