import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { buildLLMTextVariables, formatToolResultForLLM, renderLLMText, renderLLMValue } from "../core/text-renderer/src/index.js";

test("renderLLMText resolves common variable placeholders", () => {
  assert.equal(renderLLMText("hello {{ user }} at {{date_time}}", {
    user: "YY",
    date_time: "2026-05-29 12:00:00"
  }), "hello YY at 2026-05-29 12:00:00");
});

test("buildLLMTextVariables exposes date_time and time-only values", () => {
  const variables = buildLLMTextVariables({
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-29T12:34:56.000Z"))
  });
  assert.equal(variables.date_time, "2026-05-29 12:34:56");
  assert.equal(variables.date, "2026-05-29");
  assert.equal(variables.time, "12:34:56");
});

test("formatToolResultForLLM renders placeholders in string tool output", () => {
  assert.equal(formatToolResultForLLM({
    ok: true,
    output: "story for {{user}}"
  }, { user: "YY" }), "story for YY");
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

test("buildLLMTextVariables exposes dailyShell and top-level outfit without rendered", () => {
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

test("formatToolResultForLLM renders nested object output as valid JSON", () => {
  const rendered = formatToolResultForLLM({
    ok: true,
    output: {
      text: "{{user}}",
      nested: ["{{outfit/content}}"]
    }
  }, {
    user: 'A"B',
    outfit: { content: "dress" }
  });
  assert.deepEqual(JSON.parse(rendered), { text: 'A"B', nested: ["dress"] });
});

test("renderLLMValue recursively renders strings", () => {
  assert.deepEqual(renderLLMValue({ a: "{{user}}", b: ["{{missing}}"] }, { user: "YY" }), { a: "YY", b: ["{{missing}}"] });
});
