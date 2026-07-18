import { defaultAgentInitiatedBehaviorPlans, defaultAgentInitiatedBehaviorPromptProfile, normalizeAgentInitiatedBehaviorPromptProfile, readAgentInitiatedBehaviorPromptProfile, resolveAgentInitiatedBehaviorAvailability, type AgentInitiatedBehaviorPlan, type AgentInitiatedBehaviorPromptProfile } from "../domain/initiated-behavior.js";
import { HttpJsonError, readJsonBody } from "../../../../apps/api/middleware/http-utils.js";
import { writeJson } from "../../../../apps/api/routes/admin-http.js";
import { getAdminToolPlugins } from "../../../agent-profile/src/application/admin-prompt-memory-runtime.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../../apps/api/bootstrap/admin-route-context.js";

export function writeInitiatedBehaviors(context: AdminRoutesContext, response: any): void {
  context.initiatedBehaviorRunStore?.finalizeExpiredResponses(context.time.now().date);
  const plans = context.getAgentInitiatedBehaviorPlans?.() ?? defaultAgentInitiatedBehaviorPlans;
  writeJson(response, 200, {
    plans: plans.map((plan) => initiatedBehaviorPlanView(context, plan)),
    runs: context.initiatedBehaviorRunStore?.list(100) ?? [],
    buckets: context.initiatedBehaviorRunStore?.randomThirtyMinuteBuckets(context.time.now().date) ?? []
  });
}

export async function patchInitiatedBehavior(context: AdminRoutesContext, request: any, response: any, id: string): Promise<void> {
  const body = await readJsonBody(request);
  if (!id) throw new HttpJsonError(400, "behavior_id_required");
  const patch = parseInitiatedBehaviorConfigPatch(body);
  const existing = context.getAgentInitiatedBehaviorPlans?.().find((plan) => plan.id === id);
  if (patch.promptProfile && (patch.kind === "randomized" || existing?.kind === "randomized")) {
    validateRandomEventMessages(patch.promptProfile);
  }
  const plan = context.setAgentInitiatedBehaviorConfig?.(id, patch)
    ?? (typeof patch.enabled === "boolean" && Object.keys(patch).length === 1
      ? context.setAgentInitiatedBehaviorEnabled?.(id, patch.enabled)
      : undefined);
  if (!plan) throw new HttpJsonError(404, "behavior_not_found");
  writeJson(response, 200, {
    ok: true,
    plan: initiatedBehaviorPlanView(context, plan)
  });
}

export async function createInitiatedBehavior(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const id = parseInitiatedBehaviorId(body.id);
  const patch = parseInitiatedBehaviorConfigPatch(body);
  if (patch.kind === "randomized" && patch.promptProfile) validateRandomEventMessages(patch.promptProfile);
  const plan = context.createAgentInitiatedBehaviorConfig?.(id, patch);
  if (!plan) throw new HttpJsonError(400, "behavior_create_failed");
  writeJson(response, 200, {
    ok: true,
    plan: initiatedBehaviorPlanView(context, plan)
  });
}

export function deleteInitiatedBehavior(context: AdminRoutesContext, response: any, id: string): void {
  if (!id) throw new HttpJsonError(400, "behavior_id_required");
  const plan = context.deleteAgentInitiatedBehaviorConfig?.(id);
  if (!plan) throw new HttpJsonError(404, "behavior_not_found");
  writeJson(response, 200, { ok: true, id });
}

function parseInitiatedBehaviorId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpJsonError(400, "behavior_id_required");
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpJsonError(400, "invalid_behavior_id");
  return id;
}

function parseInitiatedBehaviorConfigPatch(body: Record<string, unknown>) {
  const patch: {
    enabled?: boolean;
    kind?: AgentInitiatedBehaviorPlan["kind"];
    triggerEvent?: string;
    weight?: number;
    priority?: number;
    promptProfile?: AgentInitiatedBehaviorPromptProfile;
  } = {};
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new HttpJsonError(400, "enabled_boolean_required");
    patch.enabled = body.enabled;
  }
  if ("kind" in body) {
    if (body.kind !== "event" && body.kind !== "randomized") throw new HttpJsonError(400, "invalid_behavior_kind");
    patch.kind = body.kind;
  }
  if ("triggerEvent" in body) {
    if (typeof body.triggerEvent !== "string") throw new HttpJsonError(400, "trigger_event_string_required");
    patch.triggerEvent = body.triggerEvent;
  }
  if ("weight" in body) {
    if (typeof body.weight !== "number" || !Number.isFinite(body.weight)) throw new HttpJsonError(400, "weight_number_required");
    patch.weight = body.weight;
  }
  if ("priority" in body) {
    if (typeof body.priority !== "number" || !Number.isFinite(body.priority)) throw new HttpJsonError(400, "priority_number_required");
    patch.priority = body.priority;
  }
  if ("promptProfile" in body) {
    const profile = body.promptProfile;
    validateAdminPromptLayer(profile);
    patch.promptProfile = normalizeAgentInitiatedBehaviorPromptProfile(profile);
  }
  if (Object.keys(patch).length === 0) throw new HttpJsonError(400, "empty_behavior_patch");
  return patch;
}

function validateAdminPromptLayer(value: unknown): asserts value is AgentInitiatedBehaviorPromptProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpJsonError(400, "invalid_prompt_layer");
  const layer = value as Record<string, unknown>;
  if (!layer.meta || typeof layer.meta !== "object" || Array.isArray(layer.meta)) throw new HttpJsonError(400, "prompt_meta_object_required");
  if (!Array.isArray(layer.messages)) throw new HttpJsonError(400, "prompt_messages_array_required");
  for (const value of layer.messages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpJsonError(400, "invalid_prompt_message");
    const message = value as Record<string, unknown>;
    if (!message.meta || typeof message.meta !== "object" || Array.isArray(message.meta)) throw new HttpJsonError(400, "prompt_message_meta_object_required");
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") {
      throw new HttpJsonError(400, "invalid_prompt_message_role");
    }
    if (message.toolCalls === undefined) continue;
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) throw new HttpJsonError(400, "invalid_prompt_tool_calls");
    for (const value of message.toolCalls) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpJsonError(400, "invalid_prompt_tool_call");
      const call = value as Record<string, unknown>;
      const fn = call.function;
      if (typeof call.id !== "string" || !call.id || call.type !== "function" || !fn || typeof fn !== "object" || Array.isArray(fn)) {
        throw new HttpJsonError(400, "invalid_prompt_tool_call");
      }
      const definition = fn as Record<string, unknown>;
      if (typeof definition.name !== "string" || !definition.name || typeof definition.arguments !== "string") {
        throw new HttpJsonError(400, "invalid_prompt_tool_call");
      }
    }
  }
}

function validateRandomEventMessages(profile: AgentInitiatedBehaviorPromptProfile): void {
  for (const message of profile.messages) {
    if (message.role !== "assistant") throw new HttpJsonError(400, "random_event_message_role_assistant_required");
    if (Object.prototype.hasOwnProperty.call(message, "name")) throw new HttpJsonError(400, "random_event_message_name_forbidden");
  }
}

function initiatedBehaviorPlanView(context: AdminRoutesContext, plan: AgentInitiatedBehaviorPlan) {
  return {
    ...plan,
    availability: resolveAgentInitiatedBehaviorAvailability(plan, context.promptProfileStore.get(), getAdminToolPlugins(context)),
    promptProfile: plan.promptProfilePath
      ? readAgentInitiatedBehaviorPromptProfile(plan.promptProfilePath) ?? defaultAgentInitiatedBehaviorPromptProfile(plan.id)
      : defaultAgentInitiatedBehaviorPromptProfile(plan.id)
  };
}
