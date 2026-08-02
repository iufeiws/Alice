import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createPromptContextRuntime } from "../../../src/contexts/prompt-context/src/index.js";

test("prompt context runtime exposes system_skills and installed_skills from the actual variable tree", () => {
  const runtime = createPromptContextRuntime({
    username: "YY",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-01-01T00:00:00.000Z")),
    dailyShellStore: { get: () => undefined },
    coreProfileStore: { get: () => ({ appearanceDescription: "", librarySetting: "" }) },
    memoryStore: { read: () => ({}) },
    diaryStore: { latestWakeBoundary: () => undefined },
    calendarStore: { listEntries: () => [] },
    skillsDirPath: "/custom-home/skills",
    skillsRegistry: {
      available: () => [
        { name: "weather", description: "天气查询", source: "first-party" },
        { name: "lark-doc", description: "飞书文档", source: "third-party" }
      ]
    }
  } as any);

  const systemSkills = String(runtime.getVariable("system_skills"));
  const installedSkills = String(runtime.getVariable("installed_skills"));

  assert.equal(runtime.listVariables().length > 0, true);
  assert.equal(runtime.renderText("{{system_skills}}"), systemSkills);
  assert.equal(runtime.renderText("{{installed_skills}}"), installedSkills);
  assert.equal(runtime.renderText("{{skills/dirPath}}"), "/custom-home/skills");
  assert.ok(systemSkills.includes("<system_skills>"));
  assert.ok(systemSkills.includes("<name>weather</name>"));
  assert.ok(!systemSkills.includes("lark-doc"));
  assert.ok(installedSkills.includes("<installed_skills>"));
  assert.ok(installedSkills.includes("<name>lark-doc</name>"));
  assert.ok(!installedSkills.includes("weather"));
});
