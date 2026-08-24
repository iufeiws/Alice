import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearYieldAlbertContent,
  createFinishAndWaitTools
} from "../../../../src/capabilities/tools/finish-and-wait/src/index.js";

test("Yield clear requests a fresh round and appends an Albert alert", async () => {
  const tools = createFinishAndWaitTools();
  const definition = tools.listTools()[0];

  assert.deepEqual((definition.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum, [
    "clear",
    "await_chat",
    "finish"
  ]);

  const result = await tools.execute({
    id: "call_clear",
    toolName: "Yield",
    input: { action: "clear" },
    requester: { plugin: "feishu", channelId: "chat-1", userId: "user-1" },
    externalSession: { scope: "dm", sessionId: "session-1" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.continueAfterReset, true);
  assert.deepEqual(result.appendAlbertMessage, { contentText: clearYieldAlbertContent });
  assert.deepEqual(result.llmSessionStaticMessages, [{
    role: "user",
    name: "Alert",
    content: clearYieldAlbertContent
  }]);
  const preview = await tools.execute({
    id: "preview_clear",
    toolName: "Yield",
    input: { action: "clear", __preview: true },
    requester: { plugin: "feishu", channelId: "chat-1", userId: "user-1" },
    externalSession: { scope: "dm", sessionId: "session-1" }
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.resetLLMSession, undefined);
  assert.equal(preview.appendAlbertMessage, undefined);
});
