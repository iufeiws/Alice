import { test } from "node:test";
import assert from "node:assert/strict";
import { updateEnvFile } from "../../../../src/apps/api/server/env-file.js";
import { createEnvFile, readEnvFile } from "./env-file-helpers.js";

test("updateEnvFile updates existing keys and appends new keys", () => {
  const file = createEnvFile("alice-env-update", "LLM_BASE_URL=http://old\nLLM_API_KEY=secret\n");

  updateEnvFile(file, {
    LLM_BASE_URL: "https://opencode.ai/zen/go/v1",
    AGENT_INBOUND_DEBOUNCE_MS: "8000"
  });

  assert.equal(readEnvFile(file), [
    "LLM_BASE_URL=https://opencode.ai/zen/go/v1",
    "LLM_API_KEY=secret",
    "",
    "AGENT_INBOUND_DEBOUNCE_MS=8000",
    ""
  ].join("\n"));
});

test("updateEnvFile keeps existing keys when update value is undefined", () => {
  const file = createEnvFile("alice-env-keep-undefined", "LLM_API_KEY=secret\nFEISHU_APP_SECRET=old\n");

  updateEnvFile(file, {
    LLM_API_KEY: undefined,
    FEISHU_APP_SECRET: undefined
  });

  assert.equal(readEnvFile(file), "LLM_API_KEY=secret\nFEISHU_APP_SECRET=old\n");
});
