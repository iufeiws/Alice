import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
  fs,
  makeTempDir,
  makeTinyWavBuffer,
  message,
  path,
  photoDefaults,
  promptStoragePath,
} from "./admin-routes-helpers.js";
import type { StoredConversationMessage } from "./admin-routes-helpers.js";
import { formatZonedIso, parseZonedIso } from "../../../../../src/platform/time/src/index.js";
// 类型契约：ShortMemoryEntry 定义在计划 §4.2 指定的 Memory context 模块（由实现方创建）。
import type { ShortMemoryEntry } from "../../../../../src/contexts/memory/src/short-memory-store.js";

test("memory run-day uses Memorize preset api settings", async () => {
  const fixture = createMemoryRunDayFixture();

  const response = createResponse();
  await fixture.handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);
  const preset = fixture.capturedPreset();

  assert.equal(response.statusCode, 200);
  assert.equal(preset?.name, "Memorize Custom");
  assert.equal(preset?.model, "memorize-model");
  assert.equal(preset?.temperature, 0.65);
  assert.deepEqual(preset?.extraParams, { top_p: 0.9 });
});

test("memory run-day runs memory targets in fixed order", async () => {
  const fixture = createMemoryRunDayFixture();

  const response = createResponse();
  await fixture.handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.result.results.map((entry: any) => entry.target), ["persistent", "userPreferences", "yesterdaySummary"]);
});

test("memory run-day invokes induction without a single target", async () => {
  const fixture = createMemoryRunDayFixture();

  const response = createResponse();
  await fixture.handler(createRequest("POST", "/admin/api/memory/run-day", { date: "2026-05-24" }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(fixture.capturedTarget(), undefined);
  assert.equal(fixture.capturedMessages().length, 1);
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
  fs.writeFileSync(promptStoragePath(root, "prompt-api-profile.json"), `${JSON.stringify({
    memorizePresetName: "Memorize Custom"
  })}\n`);

  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  promptStore.save({
    meta: {},
    messages: [
      { meta: { title: "Memorize", enabled: true }, role: "system", content: "custom memorize prompt" }
    ]
  });

  let capturedPreset: any;
  let capturedMessages: StoredConversationMessage[] = [];
  let capturedTarget: string | undefined;
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
    async runMemoryInductionForMessages(messages: StoredConversationMessage[], windowStartAt: string | undefined, windowEndAt: string, apiPreset: any, target?: string) {
      capturedPreset = apiPreset;
      capturedMessages = messages;
      capturedTarget = target;
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
  return { root, handler, capturedPreset: () => capturedPreset, capturedMessages: () => capturedMessages, capturedTarget: () => capturedTarget };
}

test("memory run-day reads messages from the selected sleep window", async () => {
  const root = makeTempDir("admin-memory-run-window");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  let cleared = false;
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    clearMemoryInductionSession() {
      cleared = true;
      // §8.2: 新接口要求返回完整 SessionClearResult, 不做向后兼容默认(直接解引用)。
      return { cleared: true, shortMemoryCaptured: false };
    }
  });

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/clear-session", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, { ok: true, cleared: true, shortMemoryCaptured: false });
  assert.equal(cleared, true);
});

test("memory windows do not reseed sleep boundaries from persisted sleep system messages", async () => {
  const root = makeTempDir("admin-memory-no-persisted-sleep-boundary-reseed");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler(baseContext(root, memoryStore, promptStore));

  const response = createResponse();
  await handler(createRequest("POST", "/admin/api/memory/redo-last", {}), response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "memory_git_unavailable");
});

test("memory delete-latest-sql removes the latest persistent entry", async () => {
  const root = makeTempDir("admin-memory-delete-latest-sql-persistent");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
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

// --- Short Memory 只读列表（计划 §8.1 / §12.7）---

function shortMemoryEntry(id: number, createdAtUtc: string, content: string): ShortMemoryEntry {
  return {
    id,
    createdAt: formatZonedIso(new Date(createdAtUtc), "Asia/Shanghai"),
    createdAtUtc,
    content
  };
}

// 忠实模拟 §4.2 存储契约 listLatest：按 (created_at_utc DESC, id DESC) 倒序并截断到 limit。
function fakeShortMemoryStore(entries: ShortMemoryEntry[]) {
  const limits: number[] = [];
  const store = {
    listLatest(limit: number) {
      limits.push(limit);
      return [...entries]
        .sort((a, b) => a.createdAtUtc === b.createdAtUtc ? b.id - a.id : a.createdAtUtc > b.createdAtUtc ? -1 : 1)
        .slice(0, limit);
    }
  };
  return { store, limits };
}

test("memory api returns the latest 100 short memories newest first", async () => {
  const root = makeTempDir("admin-memory-short-list");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));

  const entries = Array.from({ length: 105 }, (_, index) =>
    shortMemoryEntry(index + 1, new Date(Date.UTC(2026, 4, 1, 0, 0, index)).toISOString(), `entry ${index + 1}`)
  );
  // id 100 与 id 101 共享同一个 instant，验证同刻记录按 id 倒序稳定排序。
  entries[100] = { ...entries[100], createdAtUtc: entries[99].createdAtUtc, createdAt: entries[99].createdAt };

  const { store, limits } = fakeShortMemoryStore(entries);
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    shortMemoryStore: store
  });

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/memory", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(limits, [100], "route must request the latest 100 entries");
  assert.equal(Array.isArray(body.shortMemories), true);
  assert.equal(body.shortMemories.length, 100);

  const ids = body.shortMemories.map((entryItem: ShortMemoryEntry) => entryItem.id);
  assert.equal(ids[0], 105);
  assert.equal(ids.at(-1), 6);
  assert.equal(ids.indexOf(101), 4);
  assert.equal(ids.indexOf(100), 5);
  for (let i = 1; i < body.shortMemories.length; i += 1) {
    const prev = body.shortMemories[i - 1];
    const current = body.shortMemories[i];
    assert.ok(
      prev.createdAtUtc > current.createdAtUtc || (prev.createdAtUtc === current.createdAtUtc && prev.id > current.id),
      `expected newest-first order at index ${i}`
    );
  }

  for (const entryItem of body.shortMemories) {
    assert.equal(typeof entryItem.id, "number");
    assert.equal(typeof entryItem.createdAt, "string");
    assert.equal(typeof entryItem.createdAtUtc, "string");
    assert.equal(typeof entryItem.content, "string");
  }
});

test("memory api short memories carry createdAt and createdAtUtc for the same instant in a non-UTC timezone across a day boundary", async () => {
  const root = makeTempDir("admin-memory-short-same-instant");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));

  // baseContext 配置时区为 Asia/Shanghai（+8）；UTC 2026-05-30T19:46:02.806Z 对应的
  // 本地 wall-clock 是 2026-05-31T03:46:02.806，跨过一个自然日。
  const utc = "2026-05-30T19:46:02.806Z";
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    shortMemoryStore: {
      listLatest: () => [shortMemoryEntry(1, utc, "跨日记录")]
    }
  });

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/memory", {}), response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  const entryItem = body.shortMemories[0];
  assert.equal(entryItem.createdAt, "2026-05-31T03:46:02.806");
  assert.equal(entryItem.createdAtUtc, utc);
  assert.equal(parseZonedIso(entryItem.createdAt, "Asia/Shanghai").getTime(), new Date(utc).getTime());
  assert.notEqual(entryItem.createdAt.slice(0, 10), entryItem.createdAtUtc.slice(0, 10), "UTC 与本地日期跨日");
});

test("memory api returns a JSON error when the short memory query fails", async () => {
  const root = makeTempDir("admin-memory-short-query-fail");
  const memoryStore = createMarkdownMemoryStore(root);
  const promptStore = createMemoryInductionPromptStore(promptStoragePath(root, "memorize-prompts.json"));
  const handler = createAdminHandler({
    ...baseContext(root, memoryStore, promptStore),
    shortMemoryStore: {
      listLatest() {
        throw new Error("short memory query boom");
      }
    }
  });

  const response = createResponse();
  await handler(createRequest("GET", "/admin/api/memory", {}), response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "internal_error" });
});
