import {
  defaultAgentInitiatedBehaviorPlans,
  type AgentInitiatedBehaviorPlan
} from "../domain/initiated-behavior.js";
import {
  applyAgentInitiatedBehaviorOverrides,
  customAgentInitiatedBehaviorPlan,
  deleteAgentInitiatedBehaviorPromptProfile,
  readAgentInitiatedBehaviorOverrides,
  writeAgentInitiatedBehaviorOverrides,
  writeAgentInitiatedBehaviorPromptProfile,
  type AgentInitiatedBehaviorConfigPatch
} from "../adapters/json-initiated-behavior-store.js";

export function createInitiatedBehaviorRuntime(input: {
  configPath: string;
  appendLog(level: "warn", message: string): void;
}) {
  let overrides = readAgentInitiatedBehaviorOverrides(input.configPath, input.appendLog);

  return {
    getPlans,
    createCustom,
    deleteCustom,
    setConfig,
    setEnabled
  };

  function getPlans(): AgentInitiatedBehaviorPlan[] {
    return applyAgentInitiatedBehaviorOverrides(defaultAgentInitiatedBehaviorPlans, overrides);
  }

  function setConfig(id: string, patch: AgentInitiatedBehaviorConfigPatch): AgentInitiatedBehaviorPlan | undefined {
    const basePlan = getPlans().find((plan) => plan.id === id);
    if (!basePlan) return undefined;
    const override = {
      ...(overrides[id] ?? {})
    };
    if (basePlan.custom) override.custom = true;
    if (typeof patch.enabled === "boolean") override.enabled = patch.enabled;
    if (patch.kind === "event" || patch.kind === "randomized") override.kind = patch.kind;
    if (typeof patch.triggerEvent === "string") override.triggerEvent = patch.triggerEvent.trim() || undefined;
    if (typeof patch.weight === "number" && Number.isFinite(patch.weight)) override.weight = patch.weight;
    if (typeof patch.priority === "number" && Number.isFinite(patch.priority)) override.priority = patch.priority;
    overrides = {
      ...overrides,
      [id]: override
    };
    writeAgentInitiatedBehaviorOverrides(input.configPath, overrides);
    if (patch.promptProfile && basePlan.promptProfilePath) {
      writeAgentInitiatedBehaviorPromptProfile(basePlan.promptProfilePath, patch.promptProfile);
    }
    return getPlans().find((plan) => plan.id === id);
  }

  function createCustom(id: string, patch: AgentInitiatedBehaviorConfigPatch): AgentInitiatedBehaviorPlan | undefined {
    if (!isCustomInitiatedBehaviorId(id) || getPlans().some((plan) => plan.id === id)) return undefined;
    overrides = {
      ...overrides,
      [id]: {
        custom: true,
        enabled: patch.enabled !== false,
        kind: patch.kind === "randomized" ? "randomized" : "event",
        ...(patch.kind === "randomized" ? {
          weight: typeof patch.weight === "number" ? patch.weight : 0,
          priority: typeof patch.priority === "number" ? patch.priority : 0
        } : {
          triggerEvent: typeof patch.triggerEvent === "string" ? patch.triggerEvent.trim() : ""
        })
      }
    };
    writeAgentInitiatedBehaviorOverrides(input.configPath, overrides);
    const plan = customAgentInitiatedBehaviorPlan(id, overrides[id]);
    writeAgentInitiatedBehaviorPromptProfile(plan.promptProfilePath!, patch.promptProfile ?? { layers: [] });
    return getPlans().find((item) => item.id === id);
  }

  function deleteCustom(id: string): AgentInitiatedBehaviorPlan | undefined {
    const plan = getPlans().find((item) => item.id === id && item.custom);
    if (!plan) return undefined;
    const next = { ...overrides };
    delete next[id];
    overrides = next;
    writeAgentInitiatedBehaviorOverrides(input.configPath, overrides);
    if (plan.promptProfilePath) deleteAgentInitiatedBehaviorPromptProfile(plan.promptProfilePath);
    return plan;
  }

  function setEnabled(id: string, enabled: boolean): AgentInitiatedBehaviorPlan | undefined {
    return setConfig(id, { enabled });
  }
}

function isCustomInitiatedBehaviorId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
