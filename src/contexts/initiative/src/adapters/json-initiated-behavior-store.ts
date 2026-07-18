import {
  normalizeAgentInitiatedBehaviorPromptProfile,
  type AgentInitiatedBehaviorPlan,
  type AgentInitiatedBehaviorPromptProfile
} from "../domain/initiated-behavior.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type AgentInitiatedBehaviorOverrides = Record<string, {
  custom?: boolean;
  enabled?: boolean;
  kind?: AgentInitiatedBehaviorPlan["kind"];
  triggerEvent?: string;
  weight?: number;
  priority?: number;
}>;

export type AgentInitiatedBehaviorConfigPatch = {
  enabled?: boolean;
  kind?: AgentInitiatedBehaviorPlan["kind"];
  triggerEvent?: string;
  weight?: number;
  priority?: number;
  promptProfile?: AgentInitiatedBehaviorPromptProfile;
};

export function readAgentInitiatedBehaviorOverrides(
  filePath: string,
  appendLog: (level: "warn", message: string) => void
): AgentInitiatedBehaviorOverrides {
  if (!fs.existsSync(filePath)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const rawBehaviors = value.behaviors && typeof value.behaviors === "object" && !Array.isArray(value.behaviors)
      ? value.behaviors as Record<string, unknown>
      : {};
    const overrides: AgentInitiatedBehaviorOverrides = {};
    for (const [id, raw] of Object.entries(rawBehaviors)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      overrides[id] = {};
      if (entry.custom === true) overrides[id].custom = true;
      if (typeof entry.enabled === "boolean") overrides[id].enabled = entry.enabled;
      if (entry.kind === "event" || entry.kind === "randomized") overrides[id].kind = entry.kind;
      if (typeof entry.triggerEvent === "string") overrides[id].triggerEvent = entry.triggerEvent;
      if (typeof entry.weight === "number" && Number.isFinite(entry.weight)) overrides[id].weight = entry.weight;
      if (typeof entry.priority === "number" && Number.isFinite(entry.priority)) overrides[id].priority = entry.priority;
    }
    return overrides;
  } catch (error) {
    appendLog("warn", `initiated behavior config read failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export function writeAgentInitiatedBehaviorOverrides(filePath: string, overrides: AgentInitiatedBehaviorOverrides): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { behaviors: overrides };
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

export function writeAgentInitiatedBehaviorPromptProfile(filePath: string, profile: AgentInitiatedBehaviorPromptProfile): void {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const normalized = normalizeAgentInitiatedBehaviorPromptProfile(profile);
  const tmpPath = `${resolved}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(tmpPath, resolved);
}

export function deleteAgentInitiatedBehaviorPromptProfile(filePath: string): void {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
}

export function applyAgentInitiatedBehaviorOverrides(
  plans: AgentInitiatedBehaviorPlan[],
  overrides: AgentInitiatedBehaviorOverrides,
  customPromptProfileDir?: string
): AgentInitiatedBehaviorPlan[] {
  const builtInIds = new Set(plans.map((plan) => plan.id));
  const builtIns = plans.map((plan) => {
    const override = overrides[plan.id];
    if (!override) return plan;
    const kind = override.kind ?? plan.kind;
    return {
      ...plan,
      ...(typeof override.enabled === "boolean" ? { enabled: override.enabled } : {}),
      kind,
      ...(kind === "event" ? { triggerEvent: typeof override.triggerEvent === "string" ? override.triggerEvent : plan.triggerEvent } : { triggerEvent: undefined }),
      ...(typeof override.weight === "number" ? { weight: override.weight } : {}),
      ...(typeof override.priority === "number" ? { priority: override.priority } : {})
    };
  });
  const customs = Object.entries(overrides)
    .filter(([id, override]) => override.custom === true && override.kind !== "randomized" && !builtInIds.has(id) && /^[A-Za-z0-9_-]+$/.test(id))
    .map(([id, override]) => customAgentInitiatedBehaviorPlan(id, override, customPromptProfileDir));
  return [...builtIns, ...customs];
}

export function customAgentInitiatedBehaviorPlan(id: string, override: AgentInitiatedBehaviorOverrides[string], customPromptProfileDir?: string): AgentInitiatedBehaviorPlan {
  const promptProfilePath = customPromptProfileDir
    ? path.join(customPromptProfileDir, `${id}.json`)
    : `src/contexts/initiative/behaviors/${id}.json`;
  return {
    id,
    custom: true,
    enabled: override.enabled !== false,
    kind: "event",
    triggerEvent: typeof override.triggerEvent === "string" ? override.triggerEvent : "",
    promptProfilePath,
    steps: [{ kind: "llm_instruction", promptProfilePath }]
  };
}
