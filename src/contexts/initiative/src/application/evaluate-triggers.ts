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
import { createJsonRandomEventStore, type AgentRandomEventStore } from "../adapters/json-random-event-store.js";

export function createInitiatedBehaviorRuntime(input: {
  configPath: string;
  customPromptProfileDir?: string;
  randomEventDir: string;
  appendLog(level: "warn", message: string): void;
}) {
  let overrides = readAgentInitiatedBehaviorOverrides(input.configPath, input.appendLog);
  const randomEvents = createJsonRandomEventStore(input.randomEventDir);

  return {
    getPlans,
    createCustom,
    deleteCustom,
    setConfig,
    setEnabled,
    randomEvents
  };

  function getPlans(): AgentInitiatedBehaviorPlan[] {
    return [
      ...applyAgentInitiatedBehaviorOverrides(defaultAgentInitiatedBehaviorPlans, overrides, input.customPromptProfileDir),
      ...randomEvents.list().map(randomEvents.plan)
    ];
  }

  function setConfig(id: string, patch: AgentInitiatedBehaviorConfigPatch): AgentInitiatedBehaviorPlan | undefined {
    const basePlan = getPlans().find((plan) => plan.id === id);
    if (!basePlan) return undefined;
    if (basePlan.kind === "randomized") return updateRandomEvent(randomEvents, id, patch);
    if (patch.kind === "randomized") return undefined;
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
    if (patch.kind === "randomized") {
      const definition = randomEvents.create({
        meta: {
          id,
          enabled: patch.enabled !== false,
          weight: typeof patch.weight === "number" ? patch.weight : 0,
          priority: typeof patch.priority === "number" ? patch.priority : 0
        },
        messages: patch.promptProfile?.messages ?? []
      });
      return definition ? randomEvents.plan(definition) : undefined;
    }
    overrides = {
      ...overrides,
      [id]: {
        custom: true,
        enabled: patch.enabled !== false,
        kind: "event",
        triggerEvent: typeof patch.triggerEvent === "string" ? patch.triggerEvent.trim() : ""
      }
    };
    writeAgentInitiatedBehaviorOverrides(input.configPath, overrides);
    const plan = customAgentInitiatedBehaviorPlan(id, overrides[id], input.customPromptProfileDir);
    writeAgentInitiatedBehaviorPromptProfile(plan.promptProfilePath!, patch.promptProfile ?? { meta: {}, messages: [] });
    return getPlans().find((item) => item.id === id);
  }

  function deleteCustom(id: string): AgentInitiatedBehaviorPlan | undefined {
    const randomEvent = randomEvents.get(id);
    if (randomEvent) {
      randomEvents.delete(id);
      return randomEvents.plan(randomEvent);
    }
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

function updateRandomEvent(store: AgentRandomEventStore, id: string, patch: AgentInitiatedBehaviorConfigPatch): AgentInitiatedBehaviorPlan | undefined {
  const current = store.get(id);
  if (!current || (patch.kind !== undefined && patch.kind !== "randomized")) return undefined;
  const saved = store.save({
    ...current,
    meta: {
      ...current.meta,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(typeof patch.weight === "number" ? { weight: patch.weight } : {}),
      ...(typeof patch.priority === "number" ? { priority: patch.priority } : {})
    },
    ...(patch.promptProfile ? { messages: patch.promptProfile.messages } : {})
  });
  return store.plan(saved);
}

function isCustomInitiatedBehaviorId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
