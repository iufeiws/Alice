import { formatZonedIso } from "../../../platform/time/src/index.js";
import { readJsonBody } from "../../../apps/api/middleware/http-utils.js";
import { parseLLMApiPresetBody, publicLLMApiPresets, readLLMApiPresets, sortLLMApiPresets, writeLLMApiPresets } from "./admin-presets.js";
import { writeJson } from "../../../apps/api/routes/admin-http.js";
import { requiredString } from "../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";

export function getTokenUsagePayload(context: AdminRoutesContext, requestUrl: string): unknown {
  const url = new URL(requestUrl, "http://localhost");
  const range = url.searchParams.get("range") ?? "24h";
  const bucketParam = url.searchParams.get("bucket");
  const bucket = bucketParam === "day" ? "day" : "hour";
  const since = tokenUsageSince(context, range);
  const agentId = url.searchParams.get("agent") || "all";
  const model = url.searchParams.get("model") || "all";
  const report = context.getTokenUsageReport({ since, bucket, agentId, model }) as Record<string, unknown>;
  return {
    range,
    bucket,
    agentId,
    model,
    timeZone: context.time.timeZone,
    ...report
  };
}

export async function saveLLMApiPreset(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const name = requiredString(body.name);
  if (!name) return writeJson(response, 400, { ok: false, error: "missing_name" });
  const preset = parseLLMApiPresetBody(context, body, name);
  if ("error" in preset) return writeJson(response, 400, { ok: false, error: preset.error });
  const credential = context.credentialStore.get(preset.credentialId);
  if (!credential) return writeJson(response, 400, { ok: false, error: "credential_not_found" });
  if (credential.kind === "oauth" && credential.provider === "xai") {
    if (preset.protocol !== "openai-responses") return writeJson(response, 400, { ok: false, error: "xai_oauth_requires_responses" });
    const target = new URL(preset.baseURL);
    if (target.origin !== "https://api.x.ai" || target.pathname.replace(/\/+$/, "") !== "/v1") {
      return writeJson(response, 400, { ok: false, error: "xai_oauth_base_url_not_allowed" });
    }
  }
  const presets = readLLMApiPresets(context).filter((entry) => entry.name !== name);
  presets.push(preset);
  writeLLMApiPresets(context, presets);
  context.appendLog("info", `llm api preset saved: ${name}`);
  writeJson(response, 200, { ok: true, presets: publicLLMApiPresets(sortLLMApiPresets(presets)) });
}

export async function renameLLMApiPreset(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const from = requiredString(body.from);
  const to = requiredString(body.to);
  if (!from || !to) return writeJson(response, 400, { ok: false, error: "missing_name" });
  const presets = readLLMApiPresets(context);
  if (!presets.some((entry) => entry.name === from)) return writeJson(response, 404, { ok: false, error: "preset_not_found" });
  if (from !== to && presets.some((entry) => entry.name === to)) return writeJson(response, 409, { ok: false, error: "preset_exists" });
  const renamed = presets.map((entry) => entry.name === from ? { ...entry, name: to } : entry);
  writeLLMApiPresets(context, renamed);
  context.appendLog("info", `llm api preset renamed: ${from} -> ${to}`);
  writeJson(response, 200, { ok: true, presets: publicLLMApiPresets(sortLLMApiPresets(renamed)) });
}

export async function deleteLLMApiPreset(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const name = requiredString(body.name);
  if (!name) return writeJson(response, 400, { ok: false, error: "missing_name" });
  const presets = readLLMApiPresets(context);
  const next = presets.filter((entry) => entry.name !== name);
  if (next.length === presets.length) return writeJson(response, 404, { ok: false, error: "preset_not_found" });
  writeLLMApiPresets(context, next);
  context.appendLog("info", `llm api preset deleted: ${name}`);
  writeJson(response, 200, { ok: true, presets: publicLLMApiPresets(sortLLMApiPresets(next)) });
}

function tokenUsageSince(context: AdminRoutesContext, range: string): string {
  const hours = range === "30d" ? 24 * 30 : range === "7d" ? 24 * 7 : 24;
  return formatZonedIso(new Date(context.time.now().date.getTime() - hours * 60 * 60 * 1000), context.time.timeZone);
}
