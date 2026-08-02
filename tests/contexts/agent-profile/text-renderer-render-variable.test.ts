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
    skillsDirPath: "/alice/.agent/skills",
    skillsRegistry: { available: () => [] },
    worldWandererConfigPath: "/tmp/alice-test-missing-world-wanderer.json"
  } as any);
}

test("prompt variable tree reads through runtime", () => {
  const tree = promptVariableTree(runtime());

  assert.equal(typeof tree.user, "string");
  assert.equal(typeof (tree.dailyShell as any).persona.content, "string");
  assert.equal(typeof (tree.memory as any).userPreferences.content, "string");
});

test("prompt runtime isolates scoped variables and rejects unresolved variables", () => {
  const base = runtime();
  const loop = base.withVariables({ pose: "看镜头", round: 2 });

  assert.equal(loop.renderText("{{user}} {{pose}} round={{round}}"), "小王 看镜头 round=2");
  assert.equal(loop.getVariable("pose"), "看镜头");
  assert.equal(base.getVariable("pose"), undefined);
  assert.throws(() => base.renderText("{{pose}}"), /unresolved prompt variable: pose/);

  const nested = loop.withVariables({ pose: "挥手", user: null });
  assert.equal(nested.renderText("{{pose}}"), "挥手");
  assert.equal(nested.getVariable("user"), null);
  assert.throws(() => nested.renderText("{{user}}"), /unresolved prompt variable: user/);
});
