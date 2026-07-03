import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { buildLLMTextVariables, createLLMTextVariableRenderer, renderLLMText, renderLLMValue } from "../../../src/contexts/agent-profile/src/application/llm-text-renderer.js";

test("renderLLMText resolves common variable placeholders", () => {
  assert.equal(renderLLMText("hello {{ user }} at {{date_time}}", {
    user: "YY",
    date_time: "2026-05-29 12:00:00"
  }), "hello YY at 2026-05-29 12:00:00");
});

test("buildLLMTextVariables exposes configured-zone date_time and time-only values", () => {
  const variables = buildLLMTextVariables({
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-29T12:34:56.000Z"))
  });

  assert.equal(variables.date_time, "2026-05-29 12:34:56");
  assert.equal(variables.date, "2026-05-29");
  assert.equal(variables.time, "12:34:56");
  assert.equal(variables.date_time_utc, "2026-05-29 12:34:56");
  assert.equal(variables.date_utc, "2026-05-29");
  assert.equal(variables.time_utc, "12:34:56");
  assert.equal(variables.weekday, "星期五");
  assert.equal(variables.weekday_utc, "星期五");
});

test("buildLLMTextVariables derives configured-zone values from UTC source", () => {
  const variables = buildLLMTextVariables({
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-02T16:15:23.000Z"))
  });

  assert.equal(variables.date_time_utc, "2026-06-02 16:15:23");
  assert.equal(variables.date_time, "2026-06-03 00:15:23");
  assert.equal(variables.date_utc, "2026-06-02");
  assert.equal(variables.date, "2026-06-03");
  assert.equal(variables.time_utc, "16:15:23");
  assert.equal(variables.time, "00:15:23");
  assert.equal(variables.weekday_utc, "星期二");
  assert.equal(variables.weekday, "星期三");
});

test("buildLLMTextVariables exposes latest wake boundary date and weekday", () => {
  const variables = buildLLMTextVariables({
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-02T16:15:23.000Z")),
    wakeBoundary: {
      occurredAt: "2026-06-03T07:30:00.000",
      occurredAtUtc: "2026-06-02T23:30:00.000Z"
    }
  });

  assert.equal(renderLLMText("{{wakeBoundary/occurredAt}} {{wakeBoundary/date}} {{wakeBoundary/weekday}}", variables), "2026-06-03T07:30:00.000 2026-06-03 星期三");
});

test("buildLLMTextVariables exposes calendar context text", () => {
  const variables = buildLLMTextVariables({
    calendarContext: "<calendar>\n2026-06-22 星期一 今天\n09:30 买药\n</calendar>"
  });

  assert.equal(renderLLMText("{{calendar/context}}", variables), "<calendar>\n2026-06-22 星期一 今天\n09:30 买药\n</calendar>");
});

test("buildLLMTextVariables exposes memory limit placeholders", () => {
  const variables = buildLLMTextVariables({
    memory: {
      persistent: "p",
      userPreferences: "u",
      yesterdaySummary: "y"
    }
  });

  assert.equal(renderLLMText("{{memory/persistent/content}} {{memory/persistent/limit/lines}}/{{memory/persistent/limit/bytes}}/{{memory/persistent/limit/kib}}", variables), "p 0/0/0");
  assert.equal(renderLLMText("{{memory/userPreferences/content}} {{memory/userPreferences/limit/lines}}/{{memory/userPreferences/limit/bytes}}/{{memory/userPreferences/limit/kib}}", variables), "u 0/0/0");
  assert.equal(renderLLMText("{{memory/yesterdaySummary/content}} {{memory/yesterdaySummary/limit/lines}}/{{memory/yesterdaySummary/limit/bytes}}/{{memory/yesterdaySummary/limit/kib}}", variables), "y 0/0/0");
});

test("buildLLMTextVariables exposes library content", () => {
  const variables = buildLLMTextVariables({ librarySetting: "当前图书馆" });

  assert.equal(renderLLMText("{{library/content}}", variables), "当前图书馆");
});

test("LLMTextRenderer exposes supplied variables without prompt text changes", () => {
  const renderer = createLLMTextVariableRenderer({
    variables: () => buildLLMTextVariables({
      userName: "YY",
      time: createCurrentTimeProvider("UTC", () => new Date("2026-01-01T00:00:00.000Z")),
      extra: { available_skills: "skills from variable tree" }
    })
  });

  assert.equal(renderer.getVariable("available_skills"), "skills from variable tree");
  assert.equal(renderer.renderText("{{available_skills}}"), "skills from variable tree");
  assert.equal(renderer.listVariables().includes("available_skills"), true);
});

test("renderLLMText resolves slash paths from variable trees", () => {
  const variables = {
    dailyShell: {
      persona: {
        name: "弱气",
        content: "说话声音很小"
      }
    },
    outfit: {
      content: "黑色薄纱短袖高领上衣"
    }
  };

  assert.equal(renderLLMText("{{dailyShell/persona/name}} {{dailyShell/persona/content}} {{outfit/content}}", variables), "弱气 说话声音很小 黑色薄纱短袖高领上衣");
  assert.equal(renderLLMText("{{daily shell/persona}}", variables), "{{daily shell/persona}}");
});

test("buildLLMTextVariables exposes dailyShell and top-level outfit without rendered text", () => {
  const variables = buildLLMTextVariables({
    dailyShellRaw: {
      date: "2026-05-29",
      createdAt: "2026-05-29T12:00:00.000",
      personality: { id: "p1", name: "弱气", content: "说话声音很小" },
      relationship: { id: "r1", name: "造主", content: "称呼用户为造主" },
      outfit: { id: "o1", name: "黑裙", content: "黑色薄纱短袖高领上衣" }
    }
  });

  assert.deepEqual(variables.dailyShell, {
    date: "2026-05-29",
    createdAt: "2026-05-29T12:00:00.000",
    persona: { id: "p1", name: "弱气", content: "说话声音很小" },
    relationship: { id: "r1", name: "造主", content: "称呼用户为造主" }
  });
  assert.deepEqual(variables.outfit, { id: "o1", name: "黑裙", content: "黑色薄纱短袖高领上衣" });
});

test("renderLLMValue recursively renders strings", () => {
  assert.deepEqual(renderLLMValue({ a: "{{user}}", b: ["{{missing}}"] }, { user: "YY" }), { a: "YY", b: ["{{missing}}"] });
});
