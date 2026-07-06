import { test } from "node:test";
import assert from "node:assert/strict";
import { updateEnvFile } from "../../../../src/apps/api/server/env-file.js";
import { createEnvFile, readEnvFile } from "./env-file-helpers.js";

test("updateEnvFile deletes keys when update value is null", () => {
  const file = createEnvFile("alice-env-delete", "OBSOLETE_KEY=true\nLLM_API_KEY=secret\n");

  updateEnvFile(file, {
    AGENT_HEARTBEAT_PAUSED: "true",
    OBSOLETE_KEY: null
  });

  assert.equal(readEnvFile(file), "LLM_API_KEY=secret\n\nAGENT_HEARTBEAT_PAUSED=true\n");
});
