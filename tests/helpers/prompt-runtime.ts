import { createPromptContextRuntime, type PromptContextPrimitive, type PromptContextRuntime, type PromptContextValue } from "../../src/contexts/prompt-context/src/index.js";
import { createCurrentTimeProvider } from "../../src/platform/time/src/index.js";

export function testPromptRuntime(variables: Record<string, PromptContextValue> = {}): PromptContextRuntime {
  const runtime = createPromptContextRuntime({
    username: "user",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-01-01T00:00:00.000Z")),
    dailyShellStore: { get: () => undefined },
    coreProfileStore: { get: () => ({}) },
    memoryStore: { read: () => ({}) },
    diaryStore: { latestWakeBoundary: () => undefined },
    calendarStore: { listEntries: () => [] },
    skillsRegistry: { available: () => [] },
    worldWandererConfigPath: "/tmp/alice-test-missing-world-wanderer.json"
  });
  const flattened: Record<string, PromptContextPrimitive> = {};
  collectVariables(variables, "", flattened);
  return runtime.withVariables(flattened);
}

function collectVariables(value: PromptContextValue, prefix: string, variables: Record<string, PromptContextPrimitive>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) variables[prefix] = value as PromptContextPrimitive;
    return;
  }
  for (const [key, child] of Object.entries(value)) collectVariables(child, prefix ? `${prefix}/${key}` : key, variables);
}
