import { readJsonBody } from "../../../../apps/api/middleware/http-utils.js";
import { resolveAdminAssetPath } from "../../../../platform/storage/src/admin-asset-utils.js";
import { writeJson } from "../../../../apps/api/routes/admin-http.js";
import { requiredString } from "../../../../shared/admin-input/src/index.js";
import { formatToolResultForLLM, getAdminTextVariables, resolveAdminMessagingTarget, resolveFeishuTestTarget } from "./admin-shared.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../../apps/api/bootstrap/admin-route-context.js";

export async function handleAdminMessagingApi(context: AdminRoutesContext, request: any, response: any): Promise<boolean> {
  if (request.method === "POST" && request.url === "/admin/api/tools/messaging/view") {
    await executeMessagingTool(context, request, response, "check_chat", "feishu");
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/tools/messaging/search") {
    await executeMessagingTool(context, request, response, "search_messages", "feishu");
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/tools/messaging/send") {
    await executeMessagingTool(context, request, response, "send_chat", "feishu");
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/tools/messaging/wechat-view") {
    await executeMessagingTool(context, request, response, "check_chat", "wechat");
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/tools/messaging/wechat-search") {
    await executeMessagingTool(context, request, response, "search_messages", "wechat");
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/tools/messaging/wechat-send") {
    await executeMessagingTool(context, request, response, "send_chat", "wechat");
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/test-markdown") {
    await sendFeishuTest(context, request, response, "markdown");
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/test-image") {
    await sendFeishuTest(context, request, response, "image");
    return true;
  }
  if (request.method === "POST" && request.url === "/admin/api/plugins/feishu/test-audio") {
    await sendFeishuTest(context, request, response, "audio");
    return true;
  }
  return false;
}

export async function executeMessagingTool(
  context: AdminRoutesContext,
  request: any,
  response: any,
  toolName: "check_chat" | "search_messages" | "send_chat",
  plugin?: "feishu" | "wechat"
): Promise<void> {
  const body = await readJsonBody(request);
  const target = plugin ? resolveAdminMessagingTarget(context, plugin) : undefined;
  if (plugin && !target) {
    writeJson(response, 400, { ok: false, error: `missing_${plugin}_target` });
    return;
  }
  const result = await context.messagingTools.execute({
    id: `admin_${toolName}_${Date.now()}`,
    toolName,
    input: body,
    requester: target ? {
      plugin: target.plugin,
      accountId: target.accountId,
      channelId: target.channelId,
      userId: target.userId
    } : undefined,
    externalSession: target ? {
      scope: "dm",
      sessionId: target.sessionId
    } : undefined
  });
  context.appendLog(result.ok ? "info" : "warn", `messaging tool ${toolName}${target ? ` plugin=${target.plugin} session=${target.sessionId}` : ""}: ${result.ok ? "ok" : result.error ?? "failed"}`);
  writeJson(response, result.ok ? 200 : 400, {
    ok: result.ok,
    content: formatToolResultForLLM(result, target ? getAdminTextVariables(context, target) : undefined),
    error: result.error
  });
}

export async function sendFeishuTest(context: AdminRoutesContext, request: any, response: any, kind: "markdown" | "image" | "audio"): Promise<void> {
  const body = await readJsonBody(request);
  const target = resolveFeishuTestTarget(context, body);
  if (!target) {
    writeJson(response, 400, { ok: false, error: kind === "markdown" ? "missing_target" : "missing_target_or_asset" });
    return;
  }

  const content = contentForTest(kind, body);
  if (!content) {
    writeJson(response, 400, { ok: false, error: kind === "markdown" ? "markdown_required" : "missing_target_or_asset" });
    return;
  }

  const createdTime = context.time.now();
  await context.feishu.send({
    id: `test_${kind}_${Date.now()}`,
    target,
    content,
    meta: {
      createdAt: createdTime.iso,
      createdAtUtc: createdTime.date.toISOString(),
      urgency: "normal"
    }
  });
  const summary = "markdown" in content ? content.markdown : content.assetId;
  context.appendMessageLog({
    direction: "outbound",
    plugin: "feishu",
    kind,
    target: target.channelId ?? target.userId,
    sessionId: target.sessionId,
    summary: summary ?? kind
  });
  context.appendLog("info", `feishu ${kind} test sent`);
  writeJson(response, 200, { ok: true });
}

function contentForTest(kind: "markdown" | "image" | "audio", body: Record<string, unknown>) {
  if (kind === "markdown") {
    const markdown = requiredString(body.markdown);
    return markdown ? { kind: "markdown" as const, markdown } : undefined;
  }

  const assetId = requiredString(body.assetId);
  if (!assetId) return undefined;
  const assetPath = resolveAdminAssetPath(assetId, {
    allowedExtensions: kind === "image" ? [".png", ".jpg", ".jpeg", ".gif", ".webp"] : [".opus", ".mp3", ".m4a", ".wav"],
    maxBytes: kind === "image" ? 10 * 1024 * 1024 : 20 * 1024 * 1024
  });
  return { kind, assetId: assetPath };
}
