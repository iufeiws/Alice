import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromptContextRuntime, promptVariableTree } from "../../../src/contexts/prompt-context/src/index.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";

function runtime() {
  return createPromptContextRuntime({
    username: "小王",
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-03T23:30:00.000Z")),
    dailyShellStore: {
      get: () => ({
        date: "2026-06-04",
        createdAt: "2026-06-04T07:30:00.000",
        personality: { id: "p1", name: "弱气", content: "说话声音很小" },
        relationship: { id: "r1", name: "朋友", content: "亲近" },
        outfit: { id: "o1", name: "黑色上衣", content: "黑色薄纱短袖高领上衣" }
      })
    },
    coreProfileStore: { get: () => ({ appearanceDescription: "黑发", librarySetting: "当前图书馆" }) },
    memoryStore: { read: () => ({ persistent: "p", userPreferences: "u", yesterdaySummary: "y" }) },
    diaryStore: { latestWakeBoundary: () => ({ occurredAt: "2026-06-03T07:30:00.000" }) },
    calendarStore: { listEntries: () => [{ title: "买药", startAt: "2026-06-04T09:30:00.000" }] },
    skillsRegistry: { available: () => [] },
    worldWandererConfigPath: "/tmp/alice-test-missing-world-wanderer.json"
  } as any);
}

test("prompt context runtime renders common variables", () => {
  const promptRuntime = runtime();

  assert.equal(promptRuntime.renderText("hello {{ user }} at {{date_time}}"), "hello 小王 at 2026-06-04 07:30:00");
  assert.equal(promptRuntime.renderText("{{dailyShell/persona/name}} {{outfit/content}}"), "弱气 黑色薄纱短袖高领上衣");
  assert.equal(promptRuntime.renderText("{{outfit/content}} {{targetOutfit/content}}", {
    targetOutfit: { id: "o2", name: "红裙", content: "红色连衣裙" }
  }), "黑色薄纱短袖高领上衣 红色连衣裙");
  assert.equal(promptRuntime.renderText("{{memory/persistent/content}} {{library/content}}"), "p 当前图书馆");
  assert.equal(promptRuntime.renderText("{{daily shell/persona}}"), "{{daily shell/persona}}");
});

test("prompt variable tree reads through runtime", () => {
  const tree = promptVariableTree(runtime());

  assert.equal(tree.user, "小王");
  assert.equal((tree.dailyShell as any).persona.content, "说话声音很小");
  assert.equal((tree.memory as any).userPreferences.content, "u");
});
