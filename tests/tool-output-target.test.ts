import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolOutputTargetResolver } from "../src/contexts/capabilities/src/tool-output-target.js";

test("tool output target resolver keeps chat requester target", () => {
  const resolver = createToolOutputTargetResolver({
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "default-chat", sessionId: "default-session" })
  });

  const target = resolver({
    id: "call_1",
    toolName: "Chat",
    input: {},
    requester: { plugin: "feishu", accountId: "account-1", channelId: "chat-1", userId: "user-1" },
    externalSession: { scope: "dm", sessionId: "session-1" }
  });

  assert.deepEqual(target, {
    plugin: "feishu",
    accountId: "account-1",
    channelId: "chat-1",
    userId: "user-1",
    sessionId: "session-1"
  });
});

test("tool output target resolver maps non-message requester to default target", () => {
  const resolver = createToolOutputTargetResolver({
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "default-chat", sessionId: "default-session" })
  });

  const target = resolver({
    id: "call_1",
    toolName: "Selfie",
    input: {},
    requester: { plugin: "webrtc_voice", channelId: "call-1", userId: "browser-1" },
    externalSession: { scope: "dm", sessionId: "talk-session-1" }
  });

  assert.deepEqual(target, {
    plugin: "feishu",
    accountId: undefined,
    channelId: "default-chat",
    userId: undefined,
    sessionId: "default-session"
  });
});
