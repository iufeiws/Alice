import type { ToolPlugin } from "../../../agent-loop/src/contracts/agent-contracts.js";
import { createAdminMemoryRuntime } from "../../../memory/src/application/admin-memory-runtime.js";
import { PromptProfileValidationError, type PromptProfile, type PromptProfileStore } from "./build-system-prompt.js";
import { isToolVisibleInPromptProfile } from "../../../initiative/src/domain/initiated-behavior.js";
import { HttpJsonError, readJsonBody } from "../../../../apps/api/middleware/http-utils.js";
import { writeJson } from "../../../../apps/api/routes/admin-http.js";
import { normalizePromptApiProfile, readLLMApiPresets, resolveMemorizeApiPreset, writePromptApiProfile } from "../../../llm-gateway/src/admin-presets.js";
import { formatToolMessageContent, getAdminTextRenderer, resolveAdminMessagingTarget } from "../../../../capabilities/tools/messaging/src/admin-shared.js";
import { optionalString, requiredString } from "../../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../../apps/api/bootstrap/admin-route-context.js";

const path = await import("node:path");
export async function savePromptProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const profile = savePromptProfileOrThrow(context.promptProfileStore, body as PromptProfile);
  context.appendLog("info", `prompt profile saved: messages=${profile.layers.messages.length}`);
  writeJson(response, 200, {
    ok: true,
    profile,
    variables: context.getPromptVariableTree()
  });
}

export async function saveTalkPromptProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const profile = savePromptProfileOrThrow(context.talkPromptProfileStore, body as PromptProfile);
  context.appendLog("info", `talk prompt profile saved: messages=${profile.layers.messages.length}`);
  writeJson(response, 200, {
    ok: true,
    profile,
    variables: context.getPromptVariableTree()
  });
}

function savePromptProfileOrThrow(store: PromptProfileStore, profile: PromptProfile): PromptProfile {
  try {
    return store.save(profile);
  } catch (error) {
    if (error instanceof PromptProfileValidationError) throw new HttpJsonError(400, error.code);
    throw error;
  }
}

export async function savePromptApiProfile(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const profile = normalizePromptApiProfile(body);
  const presetNames = new Set(readLLMApiPresets(context).map((entry) => entry.name));
  if (profile.chatPresetName && !presetNames.has(profile.chatPresetName)) return writeJson(response, 400, { ok: false, error: "chat_preset_not_found" });
  if (profile.talkPresetName && !presetNames.has(profile.talkPresetName)) return writeJson(response, 400, { ok: false, error: "talk_preset_not_found" });
  if (profile.memorizePresetName && !presetNames.has(profile.memorizePresetName)) return writeJson(response, 400, { ok: false, error: "memorize_preset_not_found" });
  writePromptApiProfile(context, profile);
  context.appendLog("info", `prompt api profile saved: chat=${profile.chatPresetName ?? "(current)"} talk=${profile.talkPresetName ?? "(current)"} memorize=${profile.memorizePresetName ?? "(current)"}`);
  writeJson(response, 200, { ok: true, profile });
}

export function isMemoryTarget(value: string): value is "persistent" | "userPreferences" | "yesterdaySummary" {
  return value === "persistent" || value === "userPreferences" || value === "yesterdaySummary";
}

export function getMemoryAdminRuntime(context: AdminRoutesContext): ReturnType<typeof createAdminMemoryRuntime> {
  context.memoryAdminRuntime ??= createAdminMemoryRuntime({
    config: context.config,
    store: context.store,
    memoryStore: context.memoryStore,
    diaryStore: context.diaryStore,
    memoryInductionPromptStore: context.memoryInductionPromptStore,
    promptContextRuntime: context.getPromptRenderer(),
    sandbox: context.memorySandbox,
    agentState: context.agentState,
    isHeartbeatPaused: () => Boolean((context.messageRuntime.getStatus() as { heartbeatPaused?: unknown })?.heartbeatPaused),
    time: context.time,
    llmRequests: { send: async (input) => context.llmRequestSender ? context.llmRequestSender(input) : context.getLLM().chat(input) },
    llmSessionRoot: () => context.llmSessionRoot?.() ?? path.join(context.config.memoryFiles.root, "llm-sessions"),
    ensureMemoryConsoleSession: (windowEndAt, windowStartAt) => context.ensureMemoryConsoleSession?.(windowEndAt, windowStartAt),
    resolveMemorizeApiPreset: () => resolveMemorizeApiPreset(context),
    runMemoryInductionForMessages: context.runMemoryInductionForMessages,
    appendLog: context.appendLog
  });
  return context.memoryAdminRuntime;
}

export function writeServiceResult(response: any, result: { status: number; body: unknown }): void {
  writeJson(response, result.status, result.body);
}

export function resolvePromptPreviewTarget(context: AdminRoutesContext): { plugin: string; accountId?: string; channelId?: string; userId?: string; sessionId: string } {
  if (context.config.plugins.wechat.enabled) {
    const contact = context.wechatStateStore.listContacts()[0];
    if (contact) {
      return {
        plugin: "wechat",
        accountId: "main",
        channelId: contact.userId,
        userId: contact.userId,
        sessionId: contact.sessionId
      };
    }
  }
  const contact = context.feishuPairingStore.list()[0];
  if (contact) {
    return {
      plugin: "feishu",
      accountId: contact.accountId ?? "main",
      channelId: contact.channelId,
      userId: contact.channelId ? undefined : contact.userId,
      sessionId: contact.sessionId ?? contact.channelId ?? contact.userId ?? "preview"
    };
  }
  return { plugin: "wechat", accountId: "main", channelId: "preview", userId: "preview", sessionId: "preview" };
}

export function getVisiblePromptTools(
  context: AdminRoutesContext,
  store: PromptProfileStore = context.promptProfileStore,
  excludedToolNames: readonly string[] = []
): Array<{ name: string; description?: string }> {
  const profile = store.get();
  const excluded = new Set(excludedToolNames);
  const plugins = [context.messagingTools, context.finishAndWaitTools, context.restartTools, context.photoTools, context.wardrobeTools, context.sleepCocoonTools, context.calendarTools].filter(Boolean) as ToolPlugin[];
  return plugins.flatMap((plugin) => plugin.listTools().filter((tool) => !excluded.has(tool.name) && isToolVisibleInPromptProfile(profile, tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description
  })));
}

export function getAdminTools(context: AdminRoutesContext): Array<{
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const renderer = getAdminTextRenderer(context);
  return getAdminToolPlugins(context).flatMap((plugin) => plugin.listTools().map((tool) => ({
    pluginId: plugin.id,
    name: tool.name,
    description: renderer.renderText(tool.description),
    inputSchema: renderToolInputSchema(tool.inputSchema, renderer)
  })));
}

export async function previewToolResult(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  const body = await readJsonBody(request);
  const toolName = requiredString(body.toolName);
  const pluginId = optionalString(body.pluginId);
  const input = body.input && typeof body.input === "object" && !Array.isArray(body.input)
    ? body.input as Record<string, unknown>
    : {};
  const plugin = getAdminToolPlugins(context)
    .find((candidate) => (!pluginId || candidate.id === pluginId) && candidate.listTools().some((tool) => tool.name === toolName));
  if (!toolName || !plugin) {
    writeJson(response, 400, { ok: false, error: "unknown_tool" });
    return;
  }

  const unsafeReason = unsafePreviewReason(toolName, input);
  if (unsafeReason) {
    writeJson(response, 400, {
      ok: false,
      toolName,
      pluginId: plugin.id,
      error: unsafeReason,
      content: `error: ${unsafeReason}`
    });
    return;
  }

  const targetPlugin = body.targetPlugin === "wechat" ? "wechat" : "feishu";
  const target = resolveAdminMessagingTarget(context, targetPlugin) ?? resolvePromptPreviewTarget(context);
  try {
    const result = await plugin.execute({
      id: `admin_preview_${toolName}_${Date.now()}`,
      toolName,
      input: { ...input, __preview: true },
      requester: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      externalSession: {
        scope: "dm",
        sessionId: target.sessionId
      }
    });
    context.appendLog(result.ok ? "info" : "warn", `tool preview ${plugin.id}/${toolName}: ${result.ok ? "ok" : result.error ?? "failed"}`);
    const toolDefinition = plugin.listTools().find((tool) => tool.name === toolName);
    writeJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      pluginId: plugin.id,
      toolName,
      targetPlugin: target.plugin,
      content: formatToolMessageContent(result, getAdminTextRenderer(context), toolDefinition?.passRenderText === true),
      result
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    context.appendLog("warn", `tool preview ${plugin.id}/${toolName} failed: ${reason}`);
    writeJson(response, 500, {
      ok: false,
      pluginId: plugin.id,
      toolName,
      error: reason,
      content: `error: ${reason}`
    });
  }
}

export function getAdminToolPlugins(context: AdminRoutesContext): ToolPlugin[] {
  return [context.messagingTools, context.finishAndWaitTools, context.photoTools, context.wardrobeTools, context.bookcaseTools, context.sleepCocoonTools, context.calendarTools].filter(Boolean) as ToolPlugin[];
}

function unsafePreviewReason(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "Chat" && input.action === "send") {
    return "Chat send cannot run from tool preview";
  }
  if (toolName === "Selfie") return "Selfie cannot run from tool preview";
  if (toolName === "Wardrobe" && input.action === "switch") return "Wardrobe switch cannot run from tool preview";
  return undefined;
}

function renderToolInputSchema(schema: Record<string, unknown>, renderer: ReturnType<typeof getAdminTextRenderer>): Record<string, unknown> {
  return renderJsonSchemaNode(schema, renderer) as Record<string, unknown>;
}

function renderJsonSchemaNode(value: unknown, renderer: ReturnType<typeof getAdminTextRenderer>): unknown {
  if (Array.isArray(value)) return value.map((entry) => renderJsonSchemaNode(entry, renderer));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if ((key === "description" || key === "title") && typeof entry === "string") return [key, renderer.renderText(entry)];
    if (key === "properties" || key === "$defs" || key === "definitions" || key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf") {
      return [key, renderJsonSchemaNode(entry, renderer)];
    }
    return [key, entry];
  }));
}
