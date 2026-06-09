import { test } from "node:test";
import assert from "node:assert/strict";
import { updateEnvFile } from "../src/apps/api/server/env-file.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("updateEnvFile persists admin settings without dropping existing secrets", () => {
  const file = path.join(process.cwd(), ".tmp-tests", `alice-env-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "LLM_API_KEY=secret\nFEISHU_APP_SECRET=old\n");

  updateEnvFile(file, {
    LLM_BASE_URL: "https://opencode.ai/zen/go/v1",
    LLM_API_KEY: undefined,
    FEISHU_APP_SECRET: undefined,
    AGENT_INBOUND_DEBOUNCE_MS: "8000"
  });

  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.includes("LLM_API_KEY=secret"));
  assert.ok(content.includes("FEISHU_APP_SECRET=old"));
  assert.ok(content.includes("LLM_BASE_URL=https://opencode.ai/zen/go/v1"));
  assert.ok(content.includes("AGENT_INBOUND_DEBOUNCE_MS=8000"));
});

test("updateEnvFile can remove renamed settings", () => {
  const file = path.join(process.cwd(), ".tmp-tests", `alice-env-delete-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "AGENT_HEARTBEAT_START_PAUSED=true\nLLM_API_KEY=secret\n");

  updateEnvFile(file, {
    AGENT_HEARTBEAT_PAUSED: "true",
    AGENT_HEARTBEAT_START_PAUSED: null
  });

  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.includes("AGENT_HEARTBEAT_PAUSED=true"));
  assert.doesNotMatch(content, /^AGENT_HEARTBEAT_START_PAUSED=/m);
  assert.ok(content.includes("LLM_API_KEY=secret"));
});
