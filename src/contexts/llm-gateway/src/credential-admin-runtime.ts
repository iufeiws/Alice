import fs from "node:fs";
import { readJsonBody } from "../../../apps/api/middleware/http-utils.js";
import { writeJson } from "../../../apps/api/routes/admin-http.js";
import type { AdminRuntimeContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import { readLLMApiPresets } from "./admin-presets.js";

export async function handleCredentialAdminApi(
  context: AdminRuntimeContext,
  request: any,
  response: any
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://admin.local").pathname;
  if (!pathname.startsWith("/admin/api/credentials")) return false;

  if (request.method === "GET" && pathname === "/admin/api/credentials") {
    writeJson(response, 200, { credentials: context.credentialStore.list() });
    return true;
  }

  if (request.method === "POST" && pathname === "/admin/api/credentials/api-key") {
    const body = await readJsonBody(request);
    const id = stringField(body.id);
    const label = stringField(body.label);
    const provider = stringField(body.provider) ?? "openai-compatible";
    const apiKey = stringField(body.apiKey);
    if (!id || !label || !apiKey) {
      writeJson(response, 400, { ok: false, error: "credential_fields_required" });
      return true;
    }
    const existing = context.credentialStore.get(id);
    if (existing?.kind === "oauth") {
      writeJson(response, 409, { ok: false, error: "oauth_credential_requires_disconnect" });
      return true;
    }
    try {
      const credential = context.credentialStore.upsert({ id, label, provider, kind: "api_key", payload: { apiKey } });
      writeJson(response, 200, { ok: true, credential });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: safeError(error) });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/admin/api/credentials/xai/device") {
    const body = await readJsonBody(request);
    const credentialId = stringField(body.credentialId);
    const label = stringField(body.label);
    if (!credentialId || !label) {
      writeJson(response, 400, { ok: false, error: "credential_fields_required" });
      return true;
    }
    const existing = context.credentialStore.get(credentialId);
    if (existing && (existing.kind !== "oauth" || existing.status === "connected")) {
      writeJson(response, 409, { ok: false, error: "credential_id_in_use" });
      return true;
    }
    try {
      const session = await context.xaiOAuthService.startDeviceLogin({ credentialId, label });
      writeJson(response, 202, { ok: true, session });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: safeError(error) });
    }
    return true;
  }

  const sessionPrefix = "/admin/api/credentials/xai/device/";
  if (request.method === "GET" && pathname.startsWith(sessionPrefix)) {
    const session = context.xaiOAuthService.getSession(decodeURIComponent(pathname.slice(sessionPrefix.length)));
    writeJson(response, session ? 200 : 404, session ? { session } : { ok: false, error: "oauth_session_not_found" });
    return true;
  }

  const disconnectMatch = pathname.match(/^\/admin\/api\/credentials\/([^/]+)\/disconnect$/);
  if (request.method === "POST" && disconnectMatch) {
    const id = decodeURIComponent(disconnectMatch[1]);
    const references = credentialReferences(context, id);
    if (references.length) {
      writeJson(response, 409, { ok: false, error: "credential_in_use", references });
      return true;
    }
    try {
      await context.xaiOAuthService.disconnect(id);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: safeError(error) });
    }
    return true;
  }

  const itemMatch = pathname.match(/^\/admin\/api\/credentials\/([^/]+)$/);
  if (request.method === "DELETE" && itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    const record = context.credentialStore.get(id);
    if (!record) {
      writeJson(response, 404, { ok: false, error: "credential_not_found" });
      return true;
    }
    const references = credentialReferences(context, id);
    if (references.length) {
      writeJson(response, 409, { ok: false, error: "credential_in_use", references });
      return true;
    }
    if (record.kind === "oauth") {
      writeJson(response, 409, { ok: false, error: "oauth_credential_requires_disconnect" });
      return true;
    }
    context.credentialStore.delete(id);
    writeJson(response, 200, { ok: true });
    return true;
  }

  writeJson(response, 404, { ok: false, error: "credential_route_not_found" });
  return true;
}

export function credentialReferences(context: AdminRuntimeContext, credentialId: string): string[] {
  const references = readLLMApiPresets(context)
    .filter((preset) => preset.credentialId === credentialId)
    .map((preset) => `llm-preset:${preset.name}`);
  const photoPath = context.pluginConfigs?.photo?.configPath;
  if (photoPath && fs.existsSync(photoPath)) {
    const photo = JSON.parse(fs.readFileSync(photoPath, "utf8")) as Record<string, unknown>;
    if (photo.selfieXaiCredentialId === credentialId) references.push("photo:selfie-xai");
  }
  return references;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "credential_operation_failed";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 300);
}
