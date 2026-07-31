import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { createPromptContextRuntime } from "../../../src/contexts/prompt-context/src/index.js";

test("prompt context runtime exposes available_skills from the actual variable tree", () => {
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
      available: () => [{
        name: "weather",
        description: "天气查询"
      }]
    }
  } as any);

  const availableSkills = String(runtime.getVariable("available_skills"));

  assert.equal(runtime.listVariables().length > 0, true);
  assert.equal(runtime.renderText("{{available_skills}}"), availableSkills);
  assert.equal(runtime.renderText("{{skills/dirPath}}"), "/custom-home/skills");
  assert.ok(availableSkills);
});
