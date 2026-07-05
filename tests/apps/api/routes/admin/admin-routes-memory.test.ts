import { test } from "node:test";
import { testPromptRuntime } from "../../../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import {
  addPatch,
  assertPatchError,
  baseContext,
  createAdminHandler,
  createCalendarStore,
  createDailyShellStore,
  createDiaryStore,
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  createPromptProfileStore,
  createRawRequest,
  createRequest,
  createResponse,
  editToolClient,
  fs,
  makeTempDir,
  makeTinyWavBuffer,
  message,
  path,
  photoDefaults,
  promptStoragePath,
  runMemoryInductionForMessages,
  writePreset
} from "./admin-routes-helpers.js";
import type { LLMChatInput, StoredConversationMessage } from "./admin-routes-helpers.js";

test("memory run-day migrates legacy prompt api profile", async () => {
  const fixture = createMemoryRunDayFixture();

  const response = createResponse();
  await fixture.handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(fs.existsSync(path.join(fixture.root, "src", "contexts", "agent-profile", "prompts", "prompt-api-profile.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.root, "config", "prompt-api-profile.json")), false);
});

test("memory run-day uses Memorize preset api settings", async () => {
  const fixture = createMemoryRunDayFixture();

  const response = createResponse();
  await fixture.handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);
  const firstRequest = fixture.seen[0];

  assert.equal(response.statusCode, 200);
  assert.equal(fixture.capturedPreset()?.name, "Memorize Custom");
  assert.equal(firstRequest.model, "memorize-model");
  assert.equal(firstRequest.temperature, 0.65);
  assert.deepEqual(firstRequest.extraParams, { top_p: 0.9 });
});

test("memory run-day runs memory targets in fixed order", async () => {
  const fixture = createMemoryRunDayFixture();

  const response = createResponse();
  await fixture.handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.result.results.map((entry: any) => entry.target), ["persistent", "userPreferences", "yesterdaySummary"]);
});

test("memory run-day sends common prompt without target layers", async () => {
  const fixture = createMemoryRunDayFixture();

  const response = createResponse();
  await fixture.handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);
  const promptText = fixture.seen[0].messages.map((entry) => entry.content).join("\n");

  assert.equal(response.statusCode, 200);
  assert.match(promptText, /custom memorize common prompt/);
  assert.doesNotMatch(promptText, /persistent-only prompt/);
  assert.doesNotMatch(promptText, /user-preferences-only prompt/);
  assert.doesNotMatch(promptText, /diary-only prompt/);
});

function createMemoryRunDayFixture() {
  const root = makeTempDir("admin-memory-run-day");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "llm-api-presets.json"), `${JSON.stringify({
    presets: [{
      name: "Memorize Custom",
      baseURL: "https://memorize.example.test/v1",
      apiKey: "memorize-key",
      model: "memorize-model",
      temperature: 0.65,
      timeoutMs: 45_000,
      stream: false,
      extraParams: { top_p: 0.9 },
      followupExtraParams: {}
    }]
  })}\n`);
  fs.writeFileSync(path.join(root, "config", "prompt-api-profile.json"), `${JSON.stringify({
    memorizePresetName: "Memorize Custom"
  })}\n`);

  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  promptStore.save({
    commonLayers: [
      { id: "common", title: "Common", role: "system", enabled: true, order: 10, content: "custom memorize common prompt" }
    ],
    persistentLayers: [
      { id: "persistent", title: "Persistent", role: "user", enabled: true, order: 10, content: "persistent-only prompt" }
    ],
    userPreferencesLayers: [
      { id: "user", title: "User", role: "user", enabled: true, order: 10, content: "user-preferences-only prompt" }
    ],
    yesterdaySummaryLayers: [
      { id: "diary", title: "Diary", role: "user", enabled: true, order: 10, content: "diary-only prompt" }
    ]
  });

  const seen: LLMChatInput[] = [];
  let capturedPreset: any;
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string, windowEndAt: string, apiPreset: any) {
      capturedPreset = apiPreset;
      return runMemoryInductionForMessages({
        memoryStore,
        promptStore,
            promptContextRuntime: testPromptRuntime(),
        messages,
        windowStartAt,
        windowEndAt,
        llm: editToolClient(seen, [
          addPatch("memory\n"),
          addPatch("user\n"),
          addPatch("diary\n")
        ]),
        config: {
          enabled: true,
          baseURL: apiPreset.baseURL,
          apiKey: apiPreset.apiKey,
          model: apiPreset.model,
          temperature: apiPreset.temperature,
          timeoutMs: apiPreset.timeoutMs,
          stream: apiPreset.stream,
          extraParams: apiPreset.extraParams,
          followupExtraParams: apiPreset.followupExtraParams
        },
        nowIso: () => "2026-05-24T06:00:00.000Z",
        timezone: "Asia/Shanghai",
        log() {}
      });
    }
  });
  return { root, handler, seen, capturedPreset: () => capturedPreset };
}

test("memory run-day reads messages from the selected sleep window", async () => {
  const root = makeTempDir("admin-memory-run-window");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let capturedWindow: { startAt?: string; endAt?: string } = {};
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange(startAt: string | undefined, endAt: string) {
        capturedWindow = { startAt, endAt };
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string | undefined, windowEndAt: string) {
      return { ok: true, startedAt: "2026-05-24T06:00:00.000Z", windowStartAt, windowEndAt, messageCount: messages.length, results: [] };
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(capturedWindow, {
    startAt: "2026-05-23T22:00:00.000",
    endAt: "2026-05-24T06:00:00.000"
  });
});

test("memory run-target still processes all memory files in one workspace run", async () => {
  const root = makeTempDir("admin-memory-run-target");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let capturedTarget = "";
  let capturedMessages: StoredConversationMessage[] = [];
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string, windowEndAt: string, apiPreset: any, target: string) {
      capturedTarget = target;
      capturedMessages = messages;
      return {
        ok: true,
        startedAt: "2026-05-24T06:00:00.000Z",
        windowStartAt,
        windowEndAt,
        messageCount: messages.length,
        results: [
          { target: "persistent", ok: true, edited: true, toolCalls: [] },
          { target: "userPreferences", ok: true, edited: true, toolCalls: [] },
          { target: "yesterdaySummary", ok: true, edited: true, toolCalls: [] }
        ]
      };
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/run-target", { date: "2026-05-24", target: "userPreferences" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(capturedTarget, "userPreferences");
  assert.equal(capturedMessages.length, 1);
  assert.deepEqual(body.result.results.map((entry: any) => entry.target), ["persistent", "userPreferences", "yesterdaySummary"]);
});

test("memory admin rejects concurrent run requests", async () => {
  const root = makeTempDir("admin-memory-run-concurrent");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let activeRuns = 0;
  let maxActiveRuns = 0;
  const calls: Array<{ target?: string }> = [];
  let resolveFirstRun: () => void = () => {};
  let resolveFirstStarted: () => void = () => {};
  const firstRunRelease = new Promise<void>((resolve) => {
    resolveFirstRun = resolve;
  });
  const firstRunStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string, windowEndAt: string, apiPreset: any, target?: string) {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      calls.push({ target });
      if (calls.length === 1) {
        resolveFirstStarted();
        await firstRunRelease;
      }
      activeRuns -= 1;
      return {
        ok: true,
        startedAt: "2026-05-24T06:00:00.000Z",
        windowStartAt,
        windowEndAt,
        messageCount: messages.length,
        results: [{ target: target ?? "persistent", ok: true, edited: true, toolCalls: [] }]
      };
    }
  });

  const firstResponse = createResponse();
  const first = handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24", runId: "first" }), firstResponse);
  await firstRunStarted;

  const secondResponse = createResponse();
  const second = handler(createRequest("POST", "/admin/api/memory/run-target", { date: "2026-05-24", target: "userPreferences", runId: "second" }), secondResponse);
  await second;

  assert.equal(calls.length, 1);
  assert.equal(maxActiveRuns, 1);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(JSON.parse(secondResponse.body).error, "memory_run_already_running");

  resolveFirstRun();
  await first;

  assert.equal(calls.length, 1);
  assert.equal(maxActiveRuns, 1);
  assert.equal(firstResponse.statusCode, 200);
});

test("memory admin manual run requires paused heartbeat or sleeping state by default", async () => {
  const root = makeTempDir("admin-memory-run-paused-or-sleep");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let calls = 0;
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    agentState: { getSnapshot: () => ({ state: "idle" }), setState() {} },
    store: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages() {
      calls += 1;
      return { ok: true, startedAt: "", windowEndAt: "", messageCount: 0, results: [] };
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24", runId: "idle" }), response);

  assert.equal(response.statusCode, 409);
  const body = JSON.parse(response.body);
  assert.equal(body.error, "memory_manual_run_requires_paused_or_sleeping");
  assert.deepEqual(body.gate, { allowed: false, agentState: "idle", heartbeatPaused: false });
  assert.equal(calls, 0);
});

test("memory admin manual run is allowed when heartbeat is paused", async () => {
  const root = makeTempDir("admin-memory-run-heartbeat-paused");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let calls = 0;
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    agentState: { getSnapshot: () => ({ state: "idle" }), setState() {} },
    messageRuntime: { pauseHeartbeat() {}, resumeHeartbeat() {}, async processNow() {}, getStatus: () => ({ heartbeatPaused: true }) },
    store: {
      listMessagesByCreatedAtRange() {
        return [message("2026-05-24T01:00:00.000Z", "hello from selected day")];
      },
      listMessagesChronological() {
        return [];
      }
    },
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string | undefined, windowEndAt: string) {
      calls += 1;
      return { ok: true, startedAt: "2026-05-24T06:00:00.000Z", windowStartAt, windowEndAt, messageCount: messages.length, results: [] };
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24", runId: "paused" }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ok, true);
  assert.equal(calls, 1);
});

test("memory clear-session clears the console memorize session", async () => {
  const root = makeTempDir("admin-memory-clear-session");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  let cleared = false;
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    clearMemoryInductionSession() {
      cleared = true;
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/clear-session", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(cleared, true);
});

test("memory windows do not reseed sleep boundaries from persisted sleep system messages", async () => {
  const root = makeTempDir("admin-memory-no-persisted-sleep-boundary-reseed");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const recorded: Array<{ occurredAt: string; source: string; now: string }> = [];
  const boundaries = [
    { occurredAt: "2026-05-31T03:46:02.806", source: "inferred_gap" }
  ];
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    store: {
      listMessagesByCreatedAtRange() {
        return [];
      },
      listMessagesChronological() {
        return [
          message("2026-05-31T07:07:15.653", "我也终于能睡了"),
          { ...message("2026-05-31T07:12:33.529", "-少女已入眠-"), direction: "outbound", senderRole: "system" }
        ];
      }
    },
    diaryStore: {
      listSleepBoundaries: () => boundaries,
      recordSleepBoundary(input: { occurredAt: string; source: string; now: string }) {
        recorded.push(input);
        boundaries.push({ occurredAt: input.occurredAt, source: input.source });
      }
    }
  });

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/memory", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(recorded, []);
  assert.deepEqual(body.sleepDays, [{
    date: "2026-05-31",
    endAt: "2026-05-31T03:46:02.806",
    endAtUtc: "2026-05-30T19:46:02.806Z",
    source: "inferred_gap"
  }]);
});

test("memory git undo is unavailable for SQL-backed memory", async () => {
  const root = makeTempDir("admin-memory-git-unavailable");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));
  memoryStore.writeTarget("persistent", "persistent v1\n");

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/undo-last", {}), response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "memory_git_unavailable");
  assert.equal(memoryStore.read().persistent, "persistent v1\n");
});

test("memory git redo is unavailable for SQL-backed memory", async () => {
  const root = makeTempDir("admin-memory-git-redo-unavailable");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/redo-last", {}), response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "memory_git_unavailable");
});

test("memory delete-latest-sql removes the latest persistent entry", async () => {
  const root = makeTempDir("admin-memory-delete-latest-sql-persistent");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore)
  });

  memoryStore.writeTarget("persistent", "older memory\n", { now: "2026-05-30T08:00:00.000Z" });
  memoryStore.writeTarget("persistent", "latest memory\n", { now: "2026-06-01T08:00:00.000Z" });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/delete-latest-sql", { target: "persistent" }), response);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entry.target, "persistent");
  assert.equal(memoryStore.read().persistent, "older memory\n");
});

test("memory delete-latest-sql removes the latest user preference entry", async () => {
  const root = makeTempDir("admin-memory-delete-latest-sql-user-pref");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore)
  });

  memoryStore.writeTarget("userPreferences", "older pref\n", { now: "2026-05-30T08:00:00.000Z" });
  memoryStore.writeTarget("userPreferences", "latest pref\n", { now: "2026-06-01T08:00:00.000Z" });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/delete-latest-sql", { target: "userPreferences" }), response);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entry.target, "userPreferences");
  assert.equal(memoryStore.read().userPreferences, "older pref\n");
});

test("memory delete-latest-sql removes the latest diary entry by default", async () => {
  const root = makeTempDir("admin-memory-delete-latest-sql-diary");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore)
  });

  memoryStore.writeTarget("yesterdaySummary", "older diary\n", { localDate: "2026-05-31", now: "2026-05-31T08:00:00.000Z" });
  memoryStore.writeTarget("yesterdaySummary", "latest diary\n", { localDate: "2026-06-01", now: "2026-06-01T08:00:00.000Z" });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/delete-latest-sql", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entry.target, "yesterdaySummary");
  assert.equal(body.entry.localDate, "2026-06-01");
  assert.equal(memoryStore.read().yesterdaySummary, "older diary\n");
});

test("memory delete-latest-sql reports when no diary entry exists", async () => {
  const root = makeTempDir("admin-memory-delete-latest-sql-empty");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  const diaryStore = createDiaryStore(path.join(root, "diary", "diary.sqlite"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    diaryStore
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/delete-latest-sql", {}), response);

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "no_memory_sql_record_to_delete");
});
