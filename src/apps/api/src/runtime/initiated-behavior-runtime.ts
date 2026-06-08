import {
  defaultAgentInitiatedBehaviorPlans,
  type AgentInitiatedBehaviorPlan
} from "../../../../core/agent/src/initiated-behaviors.js";
import {
  applyAgentInitiatedBehaviorOverrides,
  readAgentInitiatedBehaviorOverrides,
  writeAgentInitiatedBehaviorOverrides,
  writeAgentInitiatedBehaviorPromptProfile,
  type AgentInitiatedBehaviorConfigPatch
} from "./initiated-behavior-config.js";

export function createInitiatedBehaviorRuntime(input: {
  configPath: string;
  appendLog(level: "warn", message: string): void;
}) {
  let overrides = readAgentInitiatedBehaviorOverrides(input.configPath, input.appendLog);

  return {
    getPlans,
    setConfig,
    setEnabled
  };

  function getPlans(): AgentInitiatedBehaviorPlan[] {
    return applyAgentInitiatedBehaviorOverrides(defaultAgentInitiatedBehaviorPlans, overrides);
  }

  function setConfig(id: string, patch: AgentInitiatedBehaviorConfigPatch): AgentInitiatedBehaviorPlan | undefined {
    const basePlan = defaultAgentInitiatedBehaviorPlans.find((plan) => plan.id === id);
    if (!basePlan) return undefined;
    const override = {
      ...(overrides[id] ?? {})
    };
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

  function setEnabled(id: string, enabled: boolean): AgentInitiatedBehaviorPlan | undefined {
    return setConfig(id, { enabled });
  }
}
