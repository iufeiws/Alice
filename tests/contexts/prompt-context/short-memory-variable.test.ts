import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromptContextRuntime, promptVariableTree } from "../../../src/contexts/prompt-context/src/index.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
// 类型契约：ShortMemoryEntry / ShortMemoryStore 定义在计划 §4.2 指定的 Memory context 模块。
// 该模块由实现方创建；本测试仅以 import type 引用，运行时由 tsx 擦除，不产生模块解析依赖。
import type { ShortMemoryEntry } from "../../../src/contexts/memory/src/short-memory-store.js";

const EMPTY_XML = "<short_memories></short_memories>";

// 忠实模拟 §4.2 的存储契约：闭区间过滤（created_at_utc >= startAtUtc AND <= endAtUtc），
// 按 (created_at_utc ASC, id ASC) 返回；同时记录调用方传入的时间窗口。
function fakeShortMemoryStore(entries: ShortMemoryEntry[]) {
  const ranges: Array<{ startAtUtc: string; endAtUtc: string }> = [];
  const store = {
    listByCreatedAtUtcRange(range: { startAtUtc: string; endAtUtc: string }) {
      ranges.push(range);
      return entries
        .filter((entry) => entry.createdAtUtc >= range.startAtUtc && entry.createdAtUtc <= range.endAtUtc)
        .sort((a, b) => a.createdAtUtc === b.createdAtUtc ? a.id - b.id : a.createdAtUtc < b.createdAtUtc ? -1 : 1);
    }
  };
  return { store, ranges };
}

function createRuntime(input: {
  now: Date;
  timeZone?: string;
  wakeBoundary?: { occurredAt: string; occurredAtUtc: string };
  entries: ShortMemoryEntry[];
}) {
  const { store, ranges } = fakeShortMemoryStore(input.entries);
  const runtime = createPromptContextRuntime({
    username: "user",
    time: createCurrentTimeProvider(input.timeZone ?? "Asia/Shanghai", () => input.now),
    dailyShellStore: { get: () => undefined },
    coreProfileStore: { get: () => ({}) },
    memoryStore: { read: () => ({}) },
    diaryStore: { latestWakeBoundary: () => input.wakeBoundary },
    calendarStore: { listEntries: () => [] },
    skillsDirPath: "/home/alice/.agent/skills",
    skillsRegistry: { available: () => [] },
    worldWandererConfigPath: "/tmp/alice-test-missing-world-wanderer.json",
    shortMemoryStore: store
  } as any);
  return { runtime, ranges };
}

function entry(id: number, createdAtUtc: string, createdAt: string, content: string): ShortMemoryEntry {
  return { id, createdAtUtc, createdAt, content };
}

test("short memory variable queries the 24h window before the latest wake boundary and filters by it", () => {
  // Asia/Shanghai（+8）：wake boundary 本地 2026-06-03T06:00:00，UTC 为 2026-06-02T22:00:00Z；
  // 24 小时窗口起点为 2026-06-01T22:00:00Z，终点为 now 的 UTC 2026-06-04T00:00:00Z。
  const { runtime, ranges } = createRuntime({
    now: new Date("2026-06-04T00:00:00.000Z"),
    timeZone: "Asia/Shanghai",
    wakeBoundary: { occurredAt: "2026-06-03T06:00:00.000", occurredAtUtc: "2026-06-02T22:00:00.000Z" },
    entries: [
      entry(1, "2026-06-01T21:59:59.000Z", "2026-06-02T05:59:59.000", "before window"),
      entry(2, "2026-06-01T22:00:00.000Z", "2026-06-02T06:00:00.000", "start boundary"),
      entry(3, "2026-06-03T06:30:00.000Z", "2026-06-03T14:30:00.000", "inside window"),
      entry(4, "2026-06-04T00:00:00.000Z", "2026-06-04T08:00:00.000", "end boundary"),
      entry(5, "2026-06-04T00:00:01.000Z", "2026-06-04T08:00:01.000", "after now")
    ]
  });

  const xml = String(runtime.getVariable("memory/shortMemory/content"));

  assert.deepEqual(ranges, [{ startAtUtc: "2026-06-01T22:00:00.000Z", endAtUtc: "2026-06-04T00:00:00.000Z" }]);
  assert.ok(xml.includes("<created_at>2026-06-02T06:00:00.000</created_at>"));
  assert.ok(xml.includes("start boundary"));
  assert.ok(xml.includes("inside window"));
  assert.ok(xml.includes("end boundary"));
  assert.ok(!xml.includes("before window"));
  assert.ok(!xml.includes("after now"));
});

test("short memory variable includes the closed interval boundary points", () => {
  const { runtime } = createRuntime({
    now: new Date("2026-06-04T00:00:00.000Z"),
    timeZone: "UTC",
    wakeBoundary: { occurredAt: "2026-06-02T22:00:00.000", occurredAtUtc: "2026-06-02T22:00:00.000Z" },
    entries: [
      entry(1, "2026-06-01T22:00:00.000Z", "2026-06-01T22:00:00.000", "at start boundary"),
      entry(2, "2026-06-04T00:00:00.000Z", "2026-06-04T00:00:00.000", "at end boundary"),
      entry(3, "2026-06-01T21:59:59.000Z", "2026-06-01T21:59:59.000", "just before start"),
      entry(4, "2026-06-04T00:00:00.001Z", "2026-06-04T00:00:00.001", "just after end")
    ]
  });

  const xml = String(runtime.getVariable("memory/shortMemory/content"));

  assert.ok(xml.includes("at start boundary"), "record exactly at startAtUtc must be included (closed interval)");
  assert.ok(xml.includes("at end boundary"), "record exactly at endAtUtc (now) must be included (closed interval)");
  assert.ok(!xml.includes("just before start"));
  assert.ok(!xml.includes("just after end"));
});

test("short memory variable returns the fixed empty XML without a wake boundary and does not query the store", () => {
  const { runtime, ranges } = createRuntime({
    now: new Date("2026-06-04T00:00:00.000Z"),
    timeZone: "Asia/Shanghai",
    wakeBoundary: undefined,
    entries: [entry(1, "2026-06-02T06:30:00.000Z", "2026-06-02T14:30:00.000", "unused")]
  });

  const xml = String(runtime.getVariable("memory/shortMemory/content"));

  assert.equal(xml, EMPTY_XML);
  assert.deepEqual(ranges, [], "no wake boundary must not trigger a range query");
});

test("short memory XML orders by createdAtUtc then id ascending and escapes & < >", () => {
  const { runtime } = createRuntime({
    now: new Date("2026-06-04T00:00:00.000Z"),
    timeZone: "Asia/Shanghai",
    wakeBoundary: { occurredAt: "2026-06-02T22:00:00.000", occurredAtUtc: "2026-06-02T22:00:00.000Z" },
    entries: [
      entry(3, "2026-06-02T06:30:00.000Z", "2026-06-02T14:30:00.000", "a & b <c>"),
      entry(1, "2026-06-02T06:30:00.000Z", "2026-06-02T14:30:00.000", "same instant id 1"),
      entry(2, "2026-06-03T06:30:00.000Z", "2026-06-03T14:30:00.000", "later entry")
    ]
  });

  const xml = String(runtime.getVariable("memory/shortMemory/content"));

  assert.ok(xml.includes("&amp;"));
  assert.ok(xml.includes("&lt;"));
  assert.ok(xml.includes("&gt;"));
  assert.ok(!xml.includes("a & b"), "raw ampersand must be escaped");
  assert.ok(!xml.includes("<c>"), "raw angle brackets must be escaped");
  assert.ok(xml.indexOf("same instant id 1") < xml.indexOf("a &amp; b"), "same createdAtUtc must order by id ascending");
  assert.ok(xml.indexOf("a &amp; b") < xml.indexOf("later entry"), "createdAtUtc ascending order");
});

test("short memory variable is visible in the variable tree and resolves through renderText", () => {
  const { runtime } = createRuntime({
    now: new Date("2026-06-04T00:00:00.000Z"),
    timeZone: "Asia/Shanghai",
    wakeBoundary: { occurredAt: "2026-06-03T06:00:00.000", occurredAtUtc: "2026-06-02T22:00:00.000Z" },
    entries: [entry(1, "2026-06-02T06:30:00.000Z", "2026-06-02T14:30:00.000", "可见内容")]
  });

  assert.ok(runtime.listVariables().includes("memory/shortMemory/content"));

  const tree = promptVariableTree(runtime) as { memory: { shortMemory: { content: unknown } } };
  const treeValue = tree.memory?.shortMemory?.content;
  assert.equal(typeof treeValue, "string");

  const direct = String(runtime.getVariable("memory/shortMemory/content"));
  assert.equal(treeValue, direct);
  assert.equal(runtime.renderText("${{memory/shortMemory/content}}"), direct);
  // 本测试不假定该变量参与任何特定 loop / layer；使用范围由 Prompt 编辑器的 layer 配置决定。
});
