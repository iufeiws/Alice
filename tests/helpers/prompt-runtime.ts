import type { PromptContextRuntime, PromptContextValue } from "../../src/contexts/prompt-context/src/index.js";

export function testPromptRuntime(variables: Record<string, PromptContextValue> = {}): PromptContextRuntime {
  return {
    renderText(content) {
      return content.replace(/\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (match, key: string) => {
        const resolved = getByPath(variables, key);
        return resolved === undefined || resolved === null || typeof resolved === "object" ? match : String(resolved);
      });
    },
    getVariable(name) {
      return getByPath(variables, name);
    },
    listVariables() {
      return flattenVariableNames(variables);
    }
  };
}

function getByPath(variables: Record<string, PromptContextValue>, path: string): PromptContextValue {
  return path.split("/").reduce<PromptContextValue>((current, segment) => {
    if (!segment || !current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return current[segment];
  }, variables);
}

function flattenVariableNames(variables: Record<string, PromptContextValue>): string[] {
  const names: string[] = [];
  collectVariableNames(variables, "", names);
  return names;
}

function collectVariableNames(value: PromptContextValue, prefix: string, names: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) names.push(prefix);
    return;
  }
  for (const [key, child] of Object.entries(value)) collectVariableNames(child, prefix ? `${prefix}/${key}` : key, names);
}
