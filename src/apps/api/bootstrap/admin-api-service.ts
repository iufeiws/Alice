import { defaultPromptRegistry } from "../../../contexts/agent-profile/src/application/build-system-prompt.js";
import type { MemoryInductionPromptStore } from "../../../contexts/memory/src/memory.js";
import { renderWebRtcVoiceCallPage } from "../../../channels/webrtc-voice/src/index.js";
import { readJsonBody } from "../middleware/http-utils.js";
import { writeHtml, writeJson } from "../routes/admin-http.js";
import { publicLLMApiPreset, publicLLMApiPresets, readLLMApiPresets, readPromptApiProfile, resolveMemorizeApiPreset, resolvePromptApiPreset } from "../../../contexts/llm-gateway/src/admin-presets.js";
import { deleteLLMApiPreset, getTokenUsagePayload, renameLLMApiPreset, saveLLMApiPreset } from "../../../contexts/llm-gateway/src/admin-runtime.js";
import { optionalString, requiredString } from "../../../shared/admin-input/src/index.js";
import { handleAdminPluginApi } from "../../../contexts/capabilities/src/admin-plugin-runtime.js";
import { handleAdminMessagingApi } from "../../../capabilities/tools/messaging/src/admin-runtime.js";
import { serveTtsAsset } from "../../../channels/tts/src/admin-runtime.js";
import { deleteShellOption, getShellConfig, readShellUiOrder, saveShellOption, saveShellSettings, saveShellUiOrder, serveShellAsset, uploadShellOutfitImage } from "../../../contexts/agent-profile/src/application/shell-admin-runtime.js";
import { AGENT_STATES, getAdminConfig, handleAdminRuntimeApi, saveAgentConfig, saveAgentState, saveCoreProfile } from "./admin-runtime.js";
import { getAdminTools, getMemoryAdminRuntime, getVisiblePromptTools, isMemoryTarget, previewToolResult, savePromptApiProfile, savePromptProfile, saveTalkPromptProfile, writeServiceResult } from "../../../contexts/agent-profile/src/application/admin-prompt-memory-runtime.js";
import { restartToolName } from "../../../capabilities/tools/restart/profile.js";
import { createInitiatedBehavior, deleteInitiatedBehavior, patchInitiatedBehavior, writeInitiatedBehaviors } from "../../../contexts/initiative/src/application/admin-runtime.js";
import type { AdminRouteServices, AdminRuntimeContext as AdminRoutesContext } from "./admin-route-context.js";

export function createAdminRouteServices(context: AdminRoutesContext): AdminRouteServices {
  return {
    handleApiRoute: (request, response) => handleAdminApiServiceRoute(context, request, response),
    appendLog: context.appendLog
  };
}

export async function handleAdminApiServiceRoute(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  if (request.method === "GET" && request.url === "/plugins/webrtc-voice/call") {
    writeHtml(response, 200, renderWebRtcVoiceCallPage());
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/admin/assets/shell/")) {
    const assetPath = request.url.slice("/admin/assets/shell/".length).split(/[?#]/, 1)[0];
    serveShellAsset(context, assetPath, response);
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/admin/assets/tts/")) {
    const assetPath = request.url.slice("/admin/assets/tts/".length).split(/[?#]/, 1)[0];
    serveTtsAsset(context, assetPath, response);
    return;
  }

  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      service: "alice-agent-api",
      llmProvider: "api-preset",
      channels: context.outputRouter.listChannels()
    });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/config") {
    writeJson(response, 200, getAdminConfig(context));
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/prompts") {
    writeJson(response, 200, {
      prompts: defaultPromptRegistry,
      profile: context.promptProfileStore.get(),
      variables: context.getPromptVariableTree()
    });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/prompt-profile") {
    writeJson(response, 200, {
      profile: context.promptProfileStore.get(),
      birthday: context.calendarStore?.latestBirthday?.(),
      variables: context.getPromptVariableTree(),
      tools: getVisiblePromptTools(context)
    });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/talk-prompt-profile") {
    writeJson(response, 200, {
      profile: context.talkPromptProfileStore.get(),
      variables: context.getPromptVariableTree(),
      tools: getVisiblePromptTools(context, context.talkPromptProfileStore, [restartToolName])
    });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/initiated-behaviors") {
    writeInitiatedBehaviors(context, response);
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/initiated-behaviors") {
    await createInitiatedBehavior(context, request, response);
    return;
  }

  if (request.method === "PATCH" && request.url.startsWith("/admin/api/initiated-behaviors/")) {
    const id = decodeURIComponent(request.url.slice("/admin/api/initiated-behaviors/".length).split("?")[0] ?? "");
    await patchInitiatedBehavior(context, request, response, id);
    return;
  }

  if (request.method === "DELETE" && request.url.startsWith("/admin/api/initiated-behaviors/")) {
    const id = decodeURIComponent(request.url.slice("/admin/api/initiated-behaviors/".length).split("?")[0] ?? "");
    deleteInitiatedBehavior(context, response, id);
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/memory/prompts") {
    writeJson(response, 200, {
      prompts: context.memoryInductionPromptStore.get(),
      apiProfile: readPromptApiProfile(context),
      apiPresets: publicLLMApiPresets(readLLMApiPresets(context))
    });
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/memory/prompts") {
    const body = await readJsonBody(request);
    const prompts = context.memoryInductionPromptStore.save(body.prompts && typeof body.prompts === "object" ? body.prompts : body);
    context.appendLog("info", "memorize prompts saved");
    writeJson(response, 200, { ok: true, prompts });
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/memory/prompts/preview") {
    const body = await readJsonBody(request);
    const target = requiredString(body.target);
    if (!isMemoryTarget(target)) return writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
    const prompts = body.prompts && typeof body.prompts === "object"
      ? body.prompts as ReturnType<MemoryInductionPromptStore["get"]>
      : undefined;
    writeServiceResult(response, getMemoryAdminRuntime(context).previewPrompts(target, prompts, resolveMemorizeApiPreset(context)));
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/prompt-api-profile") {
    writeJson(response, 200, {
      profile: readPromptApiProfile(context),
      presets: publicLLMApiPresets(readLLMApiPresets(context))
    });
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/prompt-api-profile") {
    await savePromptApiProfile(context, request, response);
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/memory") {
    const sleepDays = getMemoryAdminRuntime(context).listSleepDays();
    // 计划 §8.1: 只读返回最新 100 条(createdAtUtc DESC, id DESC 由 store 保证);
    // 查询失败抛出, 由统一 handleHttpError 返回 500 JSON 错误, 不返回部分成功数据。
    const shortMemories = context.shortMemoryStore.listLatest(100);
    writeJson(response, 200, {
      files: context.memoryStore.stats(),
      prompts: context.memoryInductionPromptStore.get(),
      sleepDays,
      shortMemories
    });
    return;
  }

  if (request.method === "GET" && request.url.startsWith("/admin/api/memory/messages")) {
    const url = new URL(request.url, "http://admin.local");
    writeServiceResult(response, getMemoryAdminRuntime(context).listDayMessages(url.searchParams.get("date") || ""));
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/memory/file") {
    const body = await readJsonBody(request);
    const target = requiredString(body.target);
    if (!isMemoryTarget(target)) return writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
    writeJson(response, 200, getMemoryAdminRuntime(context).saveFile(target, typeof body.content === "string" ? body.content : ""));
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/memory/run-day") {
    const body = await readJsonBody(request);
    writeServiceResult(response, await getMemoryAdminRuntime(context).runDay(requiredString(body.date), optionalString(body.runId), resolveMemorizeApiPreset(context)));
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/memory/run-target") {
    const body = await readJsonBody(request);
    const target = requiredString(body.target);
    if (!isMemoryTarget(target)) return writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
    writeServiceResult(response, await getMemoryAdminRuntime(context).runTarget(requiredString(body.date), target, optionalString(body.runId), resolveMemorizeApiPreset(context)));
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/memory/clear-session") {
    // §8.2: 必须等待异步 clear(含 Short Memory 采集)完成后再响应; 失败由统一错误处理返回 JSON。
    // 调用方必须返回完整 SessionClearResult, 不做向后兼容默认(§3 契约)。
    const result = await context.clearMemoryInductionSession();
    context.appendLog("info", "memorize console session clear requested");
    writeJson(response, 200, {
      ok: true,
      cleared: result.cleared,
      shortMemoryCaptured: result.shortMemoryCaptured
    });
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/memory/delete-latest-sql") {
    const body = await readJsonBody(request);
    const target = body.target === undefined ? "yesterdaySummary" : requiredString(body.target);
    if (!isMemoryTarget(target)) return writeJson(response, 400, { ok: false, error: "invalid_memory_target" });
    writeServiceResult(response, getMemoryAdminRuntime(context).deleteLatestSqlRecord(target));
    return;
  }

  if (request.method === "GET" && request.url.startsWith("/admin/api/memory/run-progress")) {
    const url = new URL(request.url, "http://admin.local");
    writeServiceResult(response, getMemoryAdminRuntime(context).getRunProgress(url.searchParams.get("id") || ""));
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/memory/undo-last") {
    writeServiceResult(response, getMemoryAdminRuntime(context).undoLastGitCommit());
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/memory/redo-last") {
    writeServiceResult(response, getMemoryAdminRuntime(context).redoLastGitCommit());
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/tools") {
    writeJson(response, 200, { tools: getAdminTools(context) });
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/tools/preview") {
    await previewToolResult(context, request, response);
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/prompt-profile") {
    await savePromptProfile(context, request, response);
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/calendar/birthday") {
    const body = await readJsonBody(request);
    const calendarSystem = body.calendarSystem === "lunar" ? "lunar" : body.calendarSystem === "gregorian" ? "gregorian" : "";
    const month = Number(body.month);
    const day = Number(body.day);
    const year = body.year === undefined || body.year === "" ? undefined : Number(body.year);
    if (!calendarSystem) return writeJson(response, 400, { ok: false, error: "invalid_calendar_system" });
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return writeJson(response, 400, { ok: false, error: "invalid_date" });
    if (year !== undefined && (!Number.isInteger(year) || year < 1 || year > 9999)) return writeJson(response, 400, { ok: false, error: "invalid_year" });
    const now = context.time.now();
    const birthday = context.calendarStore.replaceBirthday({
      title: "birthday",
      calendarSystem,
      year,
      month,
      day,
      isLeapMonth: body.isLeapMonth === true,
      now: now.iso,
      nowUtc: now.date.toISOString()
    });
    writeJson(response, 200, { ok: true, birthday });
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/talk-prompt-profile") {
    await saveTalkPromptProfile(context, request, response);
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/shell") {
    writeJson(response, 200, getShellConfig(context));
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/shell-ui/order") {
    writeJson(response, 200, { ok: true, order: readShellUiOrder() });
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/shell-ui/order") {
    await saveShellUiOrder(request, response);
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/shell-settings") {
    await saveShellSettings(context, request, response);
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/shell-option") {
    await saveShellOption(context, request, response);
    return;
  }

  if (request.method === "DELETE" && request.url === "/admin/api/shell-option") {
    await deleteShellOption(context, request, response);
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/admin/api/shell/outfit-image")) {
    await uploadShellOutfitImage(context, request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/shell/reroll") {
    context.dailyShellStore.reroll(context.time.now().date, context.time.timeZone);
    context.appendLog("info", "daily shell rerolled");
    writeJson(response, 200, getShellConfig(context));
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/llm-active-session") {
    // 终端下栏专用: 只返回激活中的会话(内存快照), 不触发任何会话文件扫描。
    writeJson(response, 200, {
      activeSession: context.getCurrentLLMSession(),
      talkActiveSession: context.getCurrentTalkLLMSession?.()
    });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/llm-requests") {
    writeJson(response, 200, {
      activeSession: context.getCurrentLLMSession(),
      talkActiveSession: context.getCurrentTalkLLMSession?.(),
      clearedSessions: context.getClearedLLMSessions(),
      talkSessions: context.getTalkLLMSessions?.() ?? [],
      memorySessions: context.getMemoryLLMSessions(),
      profilePreview: await context.getLLMRequestProfilePreview(resolvePromptApiPreset(context, "chat")),
      talkProfilePreview: await context.getTalkLLMRequestProfilePreview?.(resolvePromptApiPreset(context, "talk")),
      messagePreview: await context.getLLMRequestPreview(),
      actual: await context.getLatestActualLLMRequestPreview()
    });
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/admin/api/llm-chain/session")) {
    const url = new URL(request.url, "http://localhost");
    const id = url.searchParams.get("id") ?? "";
    if (!id) {
      writeJson(response, 400, { ok: false, error: "invalid_session_id" });
      return;
    }
    writeJson(response, 200, { session: context.getLLMSession(id) });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/llm-responses") {
    writeJson(response, 200, { responses: context.llmResponseLogs });
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/admin/api/token-usage")) {
    writeJson(response, 200, getTokenUsagePayload(context, request.url));
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/llm-chain/clear") {
    // §8.2: 必须等待异步 clear(含 Short Memory 采集)完成后再响应; 失败由统一错误处理返回 JSON。
    const result = await context.clearLLMChainCache();
    context.appendLog("info", "llm current session clear requested");
    writeJson(response, 200, { ok: true, cleared: result.cleared, shortMemoryCaptured: result.shortMemoryCaptured });
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/llm-run/cancel") {
    // §8.2: cancel 中实际发生 session clear 的阶段必须等待异步 clear 完成后再响应。
    const result = await context.cancelActiveLLMRun();
    context.appendLog("warn", `llm run cancel requested: active_request=${result.hadActiveRequest}`);
    writeJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/logs") {
    writeJson(response, 200, { logs: context.logs });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/message-logs") {
    writeJson(response, 200, { logs: context.store?.listMessages?.(500) ?? context.messageLogs });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/message-event-logs") {
    writeJson(response, 200, { logs: context.store?.listMessageLogs?.(500) ?? context.messageLogs });
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/agent-state") {
    writeJson(response, 200, { state: context.agentState.getSnapshot(), states: AGENT_STATES });
    return;
  }

  if (await handleAdminRuntimeApi(context, request, response)) {
    return;
  }

  if (await handleAdminPluginApi(context, request, response)) {
    return;
  }

  if (await handleAdminMessagingApi(context, request, response)) {
    return;
  }

  if (request.method === "GET" && request.url === "/admin/api/config/llm-presets") {
    const active = resolvePromptApiPreset(context, "chat");
    writeJson(response, 200, {
      presets: publicLLMApiPresets(readLLMApiPresets(context)),
      active: active ? publicLLMApiPreset(active) : undefined,
      activeName: active?.name
    });
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/config/llm-presets") {
    await saveLLMApiPreset(context, request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/config/llm-presets/rename") {
    await renameLLMApiPreset(context, request, response);
    return;
  }

  if (request.method === "DELETE" && request.url === "/admin/api/config/llm-presets") {
    await deleteLLMApiPreset(context, request, response);
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/config/agent") {
    await saveAgentConfig(context, request, response);
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/core-profile") {
    await saveCoreProfile(context, request, response);
    return;
  }

  if (request.method === "PUT" && request.url === "/admin/api/agent-state") {
    await saveAgentState(context, request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/runtime/heartbeat/pause") {
    context.messageRuntime.pauseHeartbeat();
    writeJson(response, 200, { ok: true, status: context.messageRuntime.getStatus() });
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/runtime/heartbeat/resume") {
    context.messageRuntime.resumeHeartbeat();
    writeJson(response, 200, { ok: true, status: context.messageRuntime.getStatus() });
    return;
  }

  if (request.method === "POST" && request.url === "/admin/api/runtime/process-now") {
    await context.messageRuntime.processNow();
    writeJson(response, 200, { ok: true, status: context.messageRuntime.getStatus() });
    return;
  }

  if (request.method === "GET" && request.url === "/v1/models") {
    const llm = context.getLLM();
    const models = llm.listModels ? await llm.listModels() : [];
    writeJson(response, 200, { object: "list", data: models });
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}
