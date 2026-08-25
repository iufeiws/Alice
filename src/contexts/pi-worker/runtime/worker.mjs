import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPiModule, readPiPackageVersion } from "./pi-module-loader.mjs";
import { createPiAgentNicknameMap, readPiAgentNames } from "./pi-agent-nickname-map.mjs";
import { accessMessages, projectLatestAssistantMessageAfter, projectLatestAssistantOutcomeAfter, projectRawMessages, projectVisibleMessages } from "./message-projection.mjs";

const packageName = "@earendil-works/pi-coding-agent";
const relayProviderId = "alice-pi-relay";
const exposedPiToolNames = new Set(["read", "write", "edit", "bash"]);
const port = Number(process.env.PI_WORKER_PORT || 8790);
const workerToken = process.env.PI_WORKER_TOKEN;
if (!workerToken) throw new Error("pi_worker_token_missing");
const cwd = process.env.HOME || "/";
const sessionRoot = process.env.PI_SESSION_ROOT || "/home/alice/.pi-sessions";
const piAgentDir = path.join(sessionRoot, ".pi-agent");
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const nicknameMap = createPiAgentNicknameMap({
  filePath: path.join(sessionRoot, "pi-agent-nicknames.json"),
  names: readPiAgentNames(path.join(runtimeDir, "pi-agent-names.txt"))
});
const maxBodyBytes = 4 * 1024 * 1024;
const maxConcurrency = positiveInteger(process.env.PI_MAX_CONCURRENCY, 2);
const maxQueueSize = positiveInteger(process.env.PI_MAX_QUEUE_SIZE, 20);
const defaultTaskTimeoutSeconds = positiveInteger(process.env.PI_TASK_TIMEOUT_SECONDS, 900);
const invocationCustomType = "alice_pi_invocation";

// Runtime projections only. The Pi JSONL sessions are the source of truth.
const sessions = new Map(); // sessionId -> session record
const activeRuns = new Set(); // sessionIds currently running an invocation
let piModule;
let piLoadError;
let relayUrl = "";
let relayToken = "";

fs.mkdirSync(sessionRoot, { recursive: true });
nicknameMap.pruneExpired();

const server = http.createServer(async (request, response) => {
  const requestController = new AbortController();
  request.once("aborted", () => requestController.abort());
  try {
    const body = await readBody(request);
    const result = await route(request, body, requestController.signal);
    response.statusCode = result.status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result.body));
  } catch (error) {
    response.statusCode = error?.message === "worker_body_too_large" ? 413 : 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`[pi-worker] listening on port=${actualPort}`);
});

async function route(request, body, signal) {
  const url = new URL(request.url || "/", "http://worker.local");
  const isHealth = request.method === "GET" && url.pathname === "/health";
  if (!isHealth && !authenticate(request)) {
    return { status: 401, body: { error: "pi_worker_auth_required" } };
  }
  if (request.method === "GET" && url.pathname === "/health") return { status: 200, body: await health() };
  if (request.method === "POST" && url.pathname === "/config") return { status: 200, body: configure(body) };
  if (request.method === "POST" && url.pathname === "/tools/execute") return { status: 200, body: await executeTool(body, signal) };
  if (request.method === "POST" && url.pathname === "/preview") return { status: 200, body: await previewSession(body) };
  if (request.method === "POST" && url.pathname === "/invocations") return { status: 200, body: await startInvocation(body) };
  if (request.method === "GET" && url.pathname === "/sessions") return { status: 200, body: await listSessions() };
  const internalSnapshotMatch = /^\/sessions-by-id\/([^/]+)\/snapshot$/.exec(url.pathname);
  if (request.method === "GET" && internalSnapshotMatch) return { status: 200, body: await sessionSnapshotBySessionId(decodeURIComponent(internalSnapshotMatch[1])) };
  const match = /^\/sessions\/([^/]+)(?:\/(messages|result|snapshot|status|send|wait|cancel|fork))?$/.exec(url.pathname);
  if (!match) return { status: 404, body: { error: "worker_route_not_found" } };
  const nickname = decodeURIComponent(match[1]);
  const action = match[2];
  if (request.method === "GET" && action === "messages") return { status: 200, body: await sessionMessages(nickname, url.searchParams.get("access")) };
  if (request.method === "GET" && action === "result") return { status: 200, body: await resultSession(nickname) };
  if (request.method === "GET" && action === "snapshot") return { status: 200, body: await sessionSnapshot(nickname) };
  if (request.method === "GET" && action === "status") return { status: 200, body: await subAgentStatus(nickname) };
  if (request.method === "POST" && action === "send") return { status: 200, body: await sendInvocation(nickname, body) };
  if (request.method === "POST" && action === "wait") return { status: 200, body: await waitSession(nickname, body) };
  if (request.method === "POST" && action === "cancel") return { status: 200, body: await cancelSession(nickname) };
  if (request.method === "POST" && action === "fork") return { status: 200, body: await forkSession(nickname, body) };
  return { status: 404, body: { error: "worker_route_not_found" } };
}

function configure(input) {
  if (!input || typeof input.relayUrl !== "string" || !input.relayUrl.trim() || typeof input.relayToken !== "string" || !input.relayToken.trim()) throw new Error("invalid_pi_worker_runtime_config");
  relayUrl = input.relayUrl;
  relayToken = input.relayToken;
  return { ok: true };
}

async function health() {
  await loadPi();
  const toolDefinitions = getToolDefinitions().filter((tool) => exposedPiToolNames.has(tool.name));
  const relayReachable = await canReachRelay();
  return {
    ready: relayReachable,
    activeRuns: [...sessions.values()].filter((record) => !isSessionIdle(record)).length,
    version: readInstalledPiVersion(),
    toolDefinitionGeneration: hash(JSON.stringify(toolDefinitions)),
    cwd,
    relayReachable,
    // 凭证指纹供宿主校验: worker 被轮换/重建后仍持旧 token 时, 宿主据此发现失效并重新下发。
    relayTokenFingerprint: relayToken ? createHash("sha256").update(relayToken).digest("hex") : undefined,
    toolDefinitions
  };
}

function readInstalledPiVersion() {
  return readPiPackageVersion(piPackageRoot());
}

async function executeTool(input, signal) {
  await loadPi();
  if (!input || typeof input.toolName !== "string" || !input.requestId) throw new Error("invalid_worker_tool_request");
  const tool = getToolDefinitions(true).find((entry) => exposedPiToolNames.has(entry.name) && entry.name === input.toolName);
  if (!tool || typeof tool.execute !== "function") throw new Error(`pi_tool_unavailable:${input.toolName}`);
  const result = await tool.execute(input.requestId, input.input || {}, signal, () => {});
  return normalizeToolResult(result);
}

// ============================================================================
// Invocations
// ============================================================================

async function startInvocation(input) {
  await loadPi();
  const message = requiredString(input?.message, "pi_invocation_message_required");
  const modelConfig = modelConfigFrom(input);
  const sessionManager = piModule.SessionManager.create(cwd, sessionRoot);
  const sessionId = sessionManager.getSessionId();
  const record = createSessionRecord(sessionId, sessionManager, sessionManager.getSessionFile());
  record.agentSession = await createAgentSessionFor(sessionManager, modelConfig);
  const nicknameEntry = nicknameMap.assign(sessionId);
  record.nickname = nicknameEntry.nickname;
  let invocationId;
  try {
    invocationId = enqueueInvocation(record, { message, nickname: nicknameEntry.nickname, ...input });
  } catch (error) {
    nicknameMap.release(nicknameEntry.nickname, sessionId);
    throw error;
  }
  sessions.set(sessionId, record);
  pumpSessions();
  return { invocationId, sessionId, nickname: nicknameEntry.nickname, status: record.invocations.get(invocationId).status };
}

async function sendInvocation(nickname, input) {
  await loadPi();
  const message = requiredString(input?.message, "pi_invocation_message_required");
  const nicknameEntry = nicknameMap.resolve(nickname);
  const record = await openSessionRecord(nicknameEntry.sessionId);
  const modelConfig = modelConfigFrom(input);
  if (!record.agentSession) {
    record.agentSession = await createAgentSessionFor(record.sessionManager, modelConfig);
  }
  const invocationId = enqueueInvocation(record, { message, nickname, ...input });
  pumpSessions();
  return { invocationId, sessionId: nicknameEntry.sessionId, nickname, status: record.invocations.get(invocationId).status };
}

async function listSessions() {
  await loadPi();
  const infos = await piModule.SessionManager.list(cwd, sessionRoot);
  return infos.map((info) => ({
    sessionId: info.id,
    nickname: nicknameMap.findBySessionId(info.id)?.nickname,
    createdAt: new Date(info.created).toISOString(),
    updatedAt: new Date(info.modified).toISOString(),
    messageCount: info.messageCount
  }));
}

async function sessionMessages(nickname, access) {
  const record = await openSessionRecord(nicknameMap.resolve(nickname).sessionId);
  return accessMessages(rawMessages(record.sessionManager), access);
}

async function resultSession(nickname) {
  const record = await openSessionRecord(nicknameMap.resolve(nickname).sessionId);
  return sessionResult(record);
}

function sessionSnapshot(nickname) {
  return openSessionRecord(nicknameMap.resolve(nickname).sessionId).then((record) => snapshot(record));
}

function sessionSnapshotBySessionId(sessionId) {
  return openSessionRecord(sessionId).then((record) => snapshot(record));
}

async function subAgentStatus(nickname) {
  const record = await openSessionRecord(nicknameMap.resolve(nickname).sessionId);
  const status = currentInvocationStatus(record);
  if (!status) throw new Error("pi_session_invocation_missing");
  return { updatedAt: updatedAt(record.sessionManager), messages: visibleMessages(record.sessionManager).length, status };
}

async function waitSession(nickname, input) {
  const record = await openSessionRecord(nicknameMap.resolve(nickname).sessionId);
  const timeoutSeconds = positiveInteger(input?.timeoutSeconds, defaultTaskTimeoutSeconds);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    if (isSessionIdle(record)) return sessionResult(record);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return isSessionIdle(record) ? sessionResult(record) : { status: "running" };
}

async function cancelSession(nickname) {
  const record = await openSessionRecord(nicknameMap.resolve(nickname).sessionId);
  if (record.activeRunInvocationIds.size > 0) {
    record.cancelRequested = true;
    void record.agentSession?.abort?.();
  } else {
    // Mark queued invocations aborted; the session remains reusable.
    for (const invocation of record.invocations.values()) {
      if (invocation.status === "queued") {
        invocation.status = "aborted";
        invocation.finalText = "pi_session_aborted";
      }
    }
  }
  return "cancelled";
}

async function forkSession(nickname, input) {
  await loadPi();
  const record = await openSessionRecord(nicknameMap.resolve(nickname).sessionId);
  const entryId = input?.entryId;
  if (entryId !== undefined && (typeof entryId !== "string" || !entryId.trim())) throw new Error("pi_fork_entry_id_invalid");
  let forked;
  if (entryId !== undefined) {
    const fresh = piModule.SessionManager.open(record.sessionManager.getSessionFile(), sessionRoot, cwd);
    fresh.createBranchedSession(entryId);
    forked = fresh;
  } else {
    forked = piModule.SessionManager.forkFrom(record.sessionManager.getSessionFile(), cwd, sessionRoot);
  }
  const newSessionId = forked.getSessionId();
  const nicknameEntry = nicknameMap.assign(newSessionId);
  const newRecord = createSessionRecord(newSessionId, forked, forked.getSessionFile(), nicknameEntry.nickname);
  sessions.set(newSessionId, newRecord);
  return { sessionId: newSessionId, nickname: nicknameEntry.nickname };
}

async function previewSession(input) {
  await loadPi();
  const modelConfig = modelConfigFrom(input);
  const sessionManager = piModule.SessionManager.inMemory(cwd);
  let session;
  try {
    session = await createAgentSessionFor(sessionManager, modelConfig);
    const systemPrompt = session.agent.state.systemPrompt;
    if (typeof systemPrompt !== "string") throw new Error("pi_system_prompt_unavailable");
    return { sessionId: sessionManager.getSessionId(), systemPrompt };
  } finally {
    session?.dispose?.();
  }
}

// ============================================================================
// Session records
// ============================================================================

function createSessionRecord(sessionId, sessionManager, sessionFile, nickname) {
  return {
    sessionId,
    nickname,
    sessionManager,
    sessionFile,
    agentSession: undefined,
    invocations: new Map(), // invocationId -> { invocationId, status, messageTarget, timeoutSeconds, finalText }
    activeRunInvocationIds: new Set(),
    cancelRequested: false
  };
}

function enqueueInvocation(record, input) {
  if (queuedInvocationCount() >= maxQueueSize) throw new Error("pi_queue_full");
  const invocationId = appendInvocationEntry(record, input);
  const invocation = {
    invocationId,
    nickname: input.nickname,
    status: "queued",
    messageTarget: input.messageTarget,
    timeoutSeconds: input.timeoutSeconds,
    message: input.message
  };
  record.invocations.set(invocationId, invocation);
  return invocationId;
}

function appendInvocationEntry(record, input) {
  const entryId = record.sessionManager.appendCustomEntry(invocationCustomType, {
    message: input.message,
    nickname: input.nickname,
    messageTarget: input.messageTarget,
    timeoutSeconds: input.timeoutSeconds
  });
  return entryId;
}

function queuedInvocationCount() {
  let count = 0;
  for (const record of sessions.values()) {
    for (const invocation of record.invocations.values()) {
      if (invocation.status === "queued") count += 1;
    }
  }
  return count;
}

function pumpSessions() {
  while (activeRuns.size < maxConcurrency) {
    const candidate = findQueuedInvocation();
    if (!candidate) return;
    const { sessionId, invocationId } = candidate;
    const record = sessions.get(sessionId);
    if (record.activeRunInvocationIds.size > 0) continue;
    activeRuns.add(sessionId);
    record.activeRunInvocationIds.add(invocationId);
    record.invocations.get(invocationId).status = "running";
    void runInvocation(sessionId, invocationId);
  }
}

function findQueuedInvocation() {
  for (const record of sessions.values()) {
    if (record.activeRunInvocationIds.size > 0) continue;
    for (const invocation of record.invocations.values()) {
      if (invocation.status === "queued") return { sessionId: record.sessionId, invocationId: invocation.invocationId };
    }
  }
  return undefined;
}

async function runInvocation(sessionId, invocationId) {
  const record = sessions.get(sessionId);
  if (!record) return;
  const timers = new Map();
  let runTimedOut = false;
  for (const id of record.activeRunInvocationIds) {
    const invocation = record.invocations.get(id);
    const timeoutSeconds = positiveInteger(invocation?.timeoutSeconds, defaultTaskTimeoutSeconds);
    const timer = setTimeout(() => {
      runTimedOut = true;
      void record.agentSession?.abort?.();
    }, timeoutSeconds * 1000);
    timers.set(id, timer);
  }
  try {
    const invocation = record.invocations.get(invocationId);
    // The gateway keeps retryable upstream attempts inside prompt(); do not
    // project a persisted intermediate error while that promise is pending.
    await record.agentSession.prompt(invocation?.message ?? "");
    if (runTimedOut) finalizeRun(record, "timed_out", "pi_session_timed_out");
    else if (record.cancelRequested) finalizeRun(record, "aborted", "pi_session_aborted");
    else {
      const outcome = projectLatestAssistantOutcomeAfter(record.sessionManager.getEntries(), invocationId);
      finalizeRun(record, outcome?.status === "failed" ? "failed" : "completed", outcome?.text ?? finalAssistantText(record.sessionManager));
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    if (runTimedOut) finalizeRun(record, "timed_out", "pi_session_timed_out");
    else if (record.cancelRequested) finalizeRun(record, "aborted", "pi_session_aborted");
    else finalizeRun(record, "failed", errorText);
  } finally {
    for (const timer of timers.values()) clearTimeout(timer);
    record.cancelRequested = false;
    activeRuns.delete(sessionId);
    pumpSessions();
  }
}

function finalizeRun(record, status, text) {
  for (const id of record.activeRunInvocationIds) {
    const invocation = record.invocations.get(id);
    if (!invocation) continue;
    invocation.status = status;
    invocation.finalText = text;
  }
  record.activeRunInvocationIds.clear();
}

function completionFrom(record, invocation) {
  return {
    sessionId: record.sessionId,
    nickname: invocation.nickname,
    invocationId: invocation.invocationId,
    status: invocation.status,
    text: invocation.finalText ?? (invocation.status === "completed" ? finalAssistantText(record.sessionManager) : "pi_session_interrupted"),
    messageTarget: invocation.messageTarget
  };
}

function latestInvocation(record, active) {
  return [...record.invocations.values()].reverse().find((invocation) => active
    ? invocation.status === "queued" || invocation.status === "running"
    : invocation.status !== "queued" && invocation.status !== "running");
}

function snapshot(record) {
  const terminal = latestInvocation(record, false);
  const active = latestInvocation(record, true);
  const lastTerminal = record.activeRunInvocationIds.size === 0 ? terminal : undefined;
  // Every terminal invocation, active or not: the host watcher deduplicates by
  // sessionId+invocationId, so earlier completions are never dropped when a
  // session runs several invocations without an idle poll in between.
  const terminalCompletions = [...record.invocations.values()]
    .filter((invocation) => invocation.status !== "queued" && invocation.status !== "running")
    .map((invocation) => completionFrom(record, invocation));
  return {
    sessionId: record.sessionId,
    nickname: record.nickname,
    idle: isSessionIdle(record),
    invocationStatus: active?.status ?? terminal?.status,
    createdAt: record.sessionManager.getHeader()?.timestamp || nowIso(),
    updatedAt: updatedAt(record.sessionManager),
    terminalCompletions,
    lastInvocation: lastTerminal ? completionFrom(record, lastTerminal) : undefined
  };
}

function isSessionIdle(record) {
  return record.activeRunInvocationIds.size === 0 && ![...record.invocations.values()].some((invocation) => invocation.status === "queued");
}

function currentInvocationStatus(record) {
  const active = latestInvocation(record, true);
  const terminal = latestInvocation(record, false);
  return active?.status ?? terminal?.status;
}

function sessionResult(record) {
  if (!isSessionIdle(record)) return { status: "running" };
  const invocation = latestInvocation(record, false);
  if (!invocation) throw new Error("pi_session_invocation_missing");
  if (invocation.status !== "completed") return { status: invocation.status };
  const message = latestAssistantMessageAfter(record.sessionManager, invocation.invocationId);
  if (!message) throw new Error("pi_session_assistant_message_missing");
  return { status: "completed", message };
}

// ============================================================================
// Session opening / Pi session creation
// ============================================================================

async function openSessionRecord(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  await loadPi();
  const manager = openSessionManager(sessionId);
  const record = createSessionRecord(sessionId, manager, manager.getSessionFile(), nicknameMap.findBySessionId(sessionId)?.nickname);
  // Rebuild the runtime projection of historical invocations from the Pi JSONL.
  for (const entry of manager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== invocationCustomType) continue;
    const outcome = projectLatestAssistantOutcomeAfter(manager.getEntries(), entry.id);
    record.invocations.set(entry.id, {
      invocationId: entry.id,
      nickname: typeof entry.data?.nickname === "string" ? entry.data.nickname : undefined,
      status: outcome?.status ?? "interrupted",
      messageTarget: entry.data?.messageTarget,
      timeoutSeconds: entry.data?.timeoutSeconds,
      message: typeof entry.data?.message === "string" ? entry.data.message : "",
      finalText: outcome?.text ?? "pi_session_interrupted"
    });
  }
  sessions.set(sessionId, record);
  return record;
}

function openSessionManager(sessionId) {
  const filePath = findSessionFile(sessionId);
  if (!filePath) throw new Error("pi_session_not_found");
  return piModule.SessionManager.open(filePath, sessionRoot, cwd);
}

function findSessionFile(sessionId) {
  for (const fileName of fs.readdirSync(sessionRoot)) {
    if (!fileName.endsWith(".jsonl")) continue;
    const filePath = path.join(sessionRoot, fileName);
    let manager;
    try {
      manager = piModule.SessionManager.open(filePath, sessionRoot, cwd);
    } catch {
      continue;
    }
    if (manager.getSessionId() === sessionId) return filePath;
  }
  return undefined;
}

async function createAgentSessionFor(sessionManager, modelConfig) {
  if (!relayUrl || !relayToken) throw new Error("pi_relay_configuration_missing");
  if (typeof modelConfig.model !== "string" || !modelConfig.model.trim()) throw new Error("pi_model_required");

  const modelRuntime = await piModule.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerProvider(relayProviderId, {
    name: "Alice Pi Relay",
    baseUrl: relayUrl,
    authHeader: true,
    api: "openai-completions",
    headers: { "x-pi-session-id": sessionManager.getSessionId() },
    models: [{
      id: modelConfig.model,
      name: modelConfig.model,
      reasoning: modelConfig.reasoning === true,
      input: modelConfig.supportsImage === true ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: modelConfig.maxTokens ?? 8_192,
      // Console Go rejects the OpenAI `developer` role. Pi otherwise enables
      // it automatically for reasoning models registered under custom providers.
      compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true }
    }]
  });
  await modelRuntime.setRuntimeApiKey(relayProviderId, relayToken, { allowNetwork: false });
  const model = modelRuntime.getModel(relayProviderId, modelConfig.model);
  if (!model) throw new Error("pi_relay_model_unavailable");

  const result = await piModule.createAgentSession({
    cwd,
    agentDir: piAgentDir,
    model,
    modelRuntime,
    tools: ["read", "bash", "edit", "write"],
    sessionManager
  });
  return result.session;
}

async function loadPi() {
  if (piModule) return piModule;
  if (piLoadError) throw piLoadError;
  try {
    piModule = await loadPiModule(piPackageRoot());
    return piModule;
  } catch (error) {
    piLoadError = new Error(`pi_package_load_failed:${error instanceof Error ? error.message : String(error)}`);
    throw piLoadError;
  }
}

function piPackageRoot() {
  const nodeModules = process.env.NODE_PATH?.split(path.delimiter).find((entry) => entry.trim());
  if (!nodeModules) throw new Error("pi_global_node_path_missing");
  return path.join(nodeModules, packageName);
}

function getToolDefinitions(withExecutors = false) {
  const candidate = piModule.createCodingTools(cwd);
  if (!Array.isArray(candidate)) throw new Error("pi_tool_definitions_unavailable");
  return candidate.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    ...(withExecutors ? { execute: tool.execute } : {})
  }));
}

// ============================================================================
// Pi JSONL helpers
// ============================================================================

function visibleMessages(manager) {
  return projectVisibleMessages(manager.getEntries());
}

function rawMessages(manager) {
  return projectRawMessages(manager.getEntries());
}

function latestAssistantMessageAfter(manager, entryId) {
  return projectLatestAssistantMessageAfter(manager.getEntries(), entryId);
}

function finalAssistantText(manager) {
  const messages = manager.buildSessionContext().messages ?? [];
  const message = [...messages].reverse().find((entry) => entry?.role === "assistant");
  return messageText(message);
}

function updatedAt(manager) {
  const entries = manager.getEntries();
  return entries.at(-1)?.timestamp || manager.getHeader()?.timestamp || nowIso();
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("")
    : "";
}

async function canReachRelay() {
  if (!relayUrl) return false;
  try {
    const relay = new URL(relayUrl);
    relay.pathname = relay.pathname.replace(/\/v1\/?$/, "") + "/health";
    const response = await fetch(relay);
    return response.status < 500;
  } catch {
    return false;
  }
}

function normalizeToolResult(result) {
  if (!result || typeof result !== "object") return { ok: true, output: result };
  return {
    ok: result.isError !== true,
    content: result.content,
    output: result.output,
    details: result.details,
    error: result.isError === true ? result.error || "pi_tool_failed" : undefined
  };
}

function modelConfigFrom(input) {
  return {
    model: typeof input?.model === "string" ? input.model : undefined,
    maxTokens: Number.isInteger(input?.maxTokens) ? input.maxTokens : undefined,
    supportsImage: input?.supportsImage === true,
    reasoning: input?.reasoning === true
  };
}

function requiredString(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

function authenticate(request) {
  const header = request.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const candidate = header.slice("Bearer ".length).trim();
  const left = Buffer.from(candidate);
  const right = Buffer.from(workerToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("worker_body_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function hash(value) {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return `pi-tools-${(result >>> 0).toString(16)}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso() {
  const current = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.PI_AGENT_TIMEZONE || "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(current).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(current.getMilliseconds()).padStart(3, "0")}`;
}
