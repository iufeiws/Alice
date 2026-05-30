import test from "node:test";
import assert from "node:assert/strict";
import { renderAdminHtmlV2 } from "../apps/api/src/admin-html.js";

test("admin llm chain uses merged session view", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /LLM Sessions/);
  assert.match(html, /id="llmChainSessions"/);
  assert.doesNotMatch(html, /id="llmChainRequests"/);
  assert.doesNotMatch(html, /id="llmChainResponses"/);
});
