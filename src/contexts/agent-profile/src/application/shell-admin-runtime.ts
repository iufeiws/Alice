import { buildLLMTextVariables } from "./llm-text-renderer.js";
import type { ShellCategory, ShellOption } from "../domain/shell.js";
import { readJsonBody, readRawBody } from "../../../../apps/api/middleware/http-utils.js";
import { writeJson } from "../../../../apps/api/routes/admin-http.js";
import { numberFromUnknown, optionalString, requiredString } from "../../../../shared/admin-input/src/index.js";
import { decodeHeaderFileName } from "../../../../channels/tts/src/admin-assets.js";
import { resolveLibrarySetting } from "../../../world-wanderer/src/admin-library-setting.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../../apps/api/bootstrap/admin-route-context.js";

const fs = await import("node:fs");
const path = await import("node:path");
export function getShellConfig(context: AdminRoutesContext): unknown {
  const config = context.dailyShellStore.getConfig(context.time.now().date, context.time.timeZone);
  const variables = buildLLMTextVariables({
    userName: context.promptProfileStore.get().userName,
    time: context.time,
    dailyShellRaw: config.daily,
    appearanceDescription: context.coreProfileStore.get().appearanceDescription,
    librarySetting: resolveLibrarySetting(context)
  });
  return {
    ...config,
    todayVariables: {
      dailyShell: variables.dailyShell,
      outfit: variables.outfit
    }
  };
}

type ShellUiOrder = Record<ShellCategory, string[]>;

function shellUiOrderPath(): string {
  return path.join("apps", "api", "admin-ui", "shell-order.json");
}

export function readShellUiOrder(): ShellUiOrder {
  const empty: ShellUiOrder = { personalities: [], relationships: [], outfits: [] };
  const filePath = shellUiOrderPath();
  if (!fs.existsSync(filePath)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ShellUiOrder>;
    return {
      personalities: normalizeIdList(parsed.personalities),
      relationships: normalizeIdList(parsed.relationships),
      outfits: normalizeIdList(parsed.outfits)
    };
  } catch {
    return empty;
  }
}

export async function saveShellUiOrder(request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const category = requiredString(body.category);
  if (!isShellCategory(category)) {
    writeJson(response, 400, { ok: false, error: "unknown_shell_category" });
    return;
  }
  const order = normalizeIdList(body.order);
  const current = readShellUiOrder();
  current[category] = order;
  const filePath = shellUiOrderPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`);
  writeJson(response, 200, { ok: true, order: current });
}

function normalizeIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length > 0).filter((id, index, ids) => ids.indexOf(id) === index)
    : [];
}

export async function saveShellSettings(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const rolloverHour = numberFromUnknown(body.rolloverHour, context.dailyShellStore.getSettings().rolloverHour);
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) {
    writeJson(response, 400, { ok: false, error: "invalid_rollover_hour" });
    return;
  }
  const settings = context.dailyShellStore.saveSettings({ rolloverHour });
  context.appendLog("info", `shell settings saved: rolloverHour=${settings.rolloverHour}`);
  writeJson(response, 200, { ok: true, ...context.dailyShellStore.getConfig(context.time.now().date, context.time.timeZone) });
}

export async function saveShellOption(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const category = requiredString(body.category);
  if (!isShellCategory(category)) {
    writeJson(response, 400, { ok: false, error: "unknown_shell_category" });
    return;
  }
  const option = body.option;
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    writeJson(response, 400, { ok: false, error: "invalid_shell_option" });
    return;
  }
  try {
    const saved = context.dailyShellStore.saveOption(category, option as ShellOption, optionalString(body.previousId));
    context.appendLog("info", `shell option saved: ${category}/${saved.id}`);
    writeJson(response, 200, { ok: true, option: saved });
  } catch (error) {
    writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "invalid_shell_option" });
  }
}

export async function deleteShellOption(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const category = requiredString(body.category);
  const id = requiredString(body.id);
  if (!isShellCategory(category)) {
    writeJson(response, 400, { ok: false, error: "unknown_shell_category" });
    return;
  }
  if (!id) {
    writeJson(response, 400, { ok: false, error: "missing_shell_id" });
    return;
  }
  context.dailyShellStore.deleteOption(category, id);
  const order = readShellUiOrder();
  order[category] = order[category].filter((item) => item !== id);
  const filePath = shellUiOrderPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(order, null, 2)}\n`);
  context.appendLog("info", `shell option deleted: ${category}/${id}`);
  writeJson(response, 200, { ok: true, order });
}

function isShellCategory(value: string): value is ShellCategory {
  return value === "personalities" || value === "relationships" || value === "outfits";
}

export function serveShellAsset(context: AdminRoutesContext, rawName: string, response: any): void {
  const normalized = path.normalize(decodeHeaderFileName(rawName));
  const fullPath = path.resolve(context.config.memoryFiles.root, "shell", normalized);
  const root = path.resolve(context.config.memoryFiles.root, "shell");
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("invalid asset path");
    return;
  }
  if (!fs.existsSync(fullPath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const extension = path.extname(fullPath).toLowerCase();
  const contentType = extension === ".png"
    ? "image/png"
    : extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp"
        ? "image/webp"
        : extension === ".gif"
          ? "image/gif"
          : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  fs.createReadStream(fullPath).pipe(response);
}

export async function uploadShellOutfitImage(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readRawBody(request, { maxBytes: 10 * 1024 * 1024 });
  if (body.length === 0) {
    writeJson(response, 400, { ok: false, error: "empty_upload" });
    return;
  }
  const shellId = requiredString(decodeHeaderFileName(optionalString(request.headers?.["x-shell-id"]) ?? ""));
  if (!shellId) {
    writeJson(response, 400, { ok: false, error: "missing_shell_id" });
    return;
  }
  const safeId = shellId.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `outfit_${Date.now()}`;
  const outfitDir = path.join(context.config.memoryFiles.root, "shell", "outfits");
  const storedName = `${safeId}.jpg`;
  const fullPath = path.join(outfitDir, storedName);
  fs.mkdirSync(outfitDir, { recursive: true });
  fs.writeFileSync(fullPath, body);
  const imageUrl = path.join(context.config.memoryFiles.root, "shell", "outfits", storedName);
  context.appendLog("info", `shell outfit image uploaded: ${imageUrl}`);
  writeJson(response, 200, { ok: true, imageUrl });
}
