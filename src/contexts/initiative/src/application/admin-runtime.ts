import { defaultAgentInitiatedBehaviorPlans, defaultAgentInitiatedBehaviorPromptProfile, readAgentInitiatedBehaviorPromptProfile, resolveAgentInitiatedBehaviorAvailability, type AgentInitiatedBehaviorPlan } from "../domain/initiated-behavior.js";
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
  const plan = context.createAgentInitiatedBehaviorConfig?.(id, parseInitiatedBehaviorConfigPatch(body));
  if (!plan) throw new HttpJsonError(400, "behavior_create_failed");
  writeJson(response, 200, {
    ok: true,
    plan: initiatedBehaviorPlanView(context, plan)
  });
}

export function deleteInitiatedBehavior(context: AdminRoutesContext, response: any, id: string): void {
  if (!id) throw new HttpJsonError(400, "behavior_id_required");
  const plan = context.deleteAgentInitiatedBehaviorConfig?.(id);
  if (!plan) throw new HttpJsonError(404, "custom_behavior_not_found");
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
    promptProfile?: {
      layers: Array<{
        id: string;
        title: string;
        role: "user" | "assistant" | "tool_request";
        name?: string;
        enabled: boolean;
        content: string;
        order: number;
        toolCalls?: Array<{
          toolName: string;
          toolCallId?: string;
          toolArguments: string;
        }>;
        thinking?: string;
      }>;
    };
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
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new HttpJsonError(400, "invalid_prompt_profile");
    const rawLayers = (profile as { layers?: unknown }).layers;
    if (!Array.isArray(rawLayers)) throw new HttpJsonError(400, "prompt_layers_array_required");
    patch.promptProfile = {
      layers: rawLayers.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpJsonError(400, "invalid_prompt_layer");
        const layer = raw as Record<string, unknown>;
        if (layer.role !== "user" && layer.role !== "assistant" && layer.role !== "tool_request") {
          throw new HttpJsonError(400, "invalid_initiated_behavior_prompt_layer_role");
        }
        const role: "user" | "assistant" | "tool_request" = layer.role;
        const normalized = {
          id: typeof layer.id === "string" && layer.id ? layer.id : `layer_${index + 1}`,
          title: typeof layer.title === "string" ? layer.title : "",
          role,
          name: typeof layer.name === "string" && layer.name ? layer.name : "{{user}}",
          enabled: layer.enabled !== false,
          content: typeof layer.content === "string" ? layer.content : "",
          order: typeof layer.order === "number" && Number.isFinite(layer.order) ? layer.order : (index + 1) * 10
        };
        if ((role === "assistant" || role === "tool_request") && typeof layer.thinking === "string") {
          return {
            ...normalized,
            thinking: layer.thinking,
            ...(role === "tool_request" ? {
              toolCalls: normalizeAdminPromptToolCalls(layer.toolCalls)
            } : {})
          };
        }
        if (role === "tool_request") {
          return {
            ...normalized,
            toolCalls: normalizeAdminPromptToolCalls(layer.toolCalls)
          };
        }
        return normalized;
      })
    };
  }
  if (Object.keys(patch).length === 0) throw new HttpJsonError(400, "empty_behavior_patch");
  return patch;
}

function normalizeAdminPromptToolCalls(value: unknown): Array<{ toolName: string; toolCallId?: string; toolArguments: string }> {
  if (!Array.isArray(value)) throw new HttpJsonError(400, "prompt_tool_calls_array_required");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpJsonError(400, "invalid_prompt_tool_call");
    const call = raw as Record<string, unknown>;
    if (typeof call.toolName !== "string" || !call.toolName) throw new HttpJsonError(400, "tool_name_string_required");
    return {
      toolName: call.toolName,
      toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : undefined,
      toolArguments: typeof call.toolArguments === "string" ? call.toolArguments : "{}"
    };
  });
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
