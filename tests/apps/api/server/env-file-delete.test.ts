import { test } from "node:test";
import assert from "node:assert/strict";
import { updateEnvFile } from "../../../../src/apps/api/server/env-file.js";
import { createEnvFile, readEnvFile } from "./env-file-helpers.js";

test("updateEnvFile deletes keys when update value is null", () => {
  const file = createEnvFile("alice-env-delete", "AGENT_HEARTBEAT_START_PAUSED=true\nLLM_API_KEY=secret\n");

  updateEnvFile(file, {
    AGENT_HEARTBEAT_PAUSED: "true",
    AGENT_HEARTBEAT_START_PAUSED: null
  });

  assert.equal(readEnvFile(file), "LLM_API_KEY=secret\n\nAGENT_HEARTBEAT_PAUSED=true\n");
});
