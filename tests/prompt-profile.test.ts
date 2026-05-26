import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptMessages,
  buildPromptMessagesWithToolResults,
  createPromptProfileStore,
  defaultPromptProfile
} from "../core/agent/src/prompts.js";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import type { AgentEvent } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("prompt profile store creates defaults and persists edits", () => {
  const filePath = path.join(makeTempDir("prompt-store"), "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  const initial = store.get();
  assert.equal(initial.userName, "user");
  assert.deepEqual(initial.layers.map((layer) => layer.title), [
    "安全边际",
    "角色设定",
    "职责",
    "Skill",
    "壳设定 + DeepSeek Role Immersion"
  ]);

  const saved = store.save({
    ...initial,
    userName: "AliceUser",
    visibleTools: { feishu: false },
    layers: [
      { id: "custom", title: "Custom", role: "system", enabled: true, content: "Hi {{user}} at {{time}}", order: 1 }
    ]
  });
  assert.equal(saved.userName, "AliceUser");
  assert.equal(saved.visibleTools.feishu, false);

  const reopened = createPromptProfileStore(filePath).get();
  assert.equal(reopened.userName, "AliceUser");
  assert.equal(reopened.layers[0].content, "Hi {{user}} at {{time}}");
});

test("prompt messages render variables and preserve unknown placeholders", () => {
  const profile = {
    ...defaultPromptProfile(),
    userName: "小王",
    layers: [
      { id: "one", title: "One", role: "system" as const, enabled: true, content: "{{user}} {{timezone}} {{session}} {{missing}}", order: 1 }
    ]
  };
  const messages = buildPromptMessages(profile, {
    event: textEvent(),
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z"))
  });

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /小王/);
  assert.match(messages[0].content, /Asia\/Shanghai/);
  assert.match(messages[0].content, /session-1/);
  assert.match(messages[0].content, /\{\{missing\}\}/);
});

test("prompt messages pair tool request layers with actual tool results", async () => {
  const profile = {
    ...defaultPromptProfile(),
    userName: "小王",
    layers: [
      {
        id: "request",
        title: "Tool Request",
        role: "tool_request" as const,
        enabled: true,
        content: "",
        thinking: "thinking for {{user}}",
        toolName: "check_feishu",
        toolCallId: "call_prompt_1",
        toolArguments: "{\"scope\":\"today\"}",
        order: 1
      }
    ]
  };

  const messages = await buildPromptMessagesWithToolResults(profile, {
    event: textEvent(),
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z"))
  }, async (layer, call) => {
    assert.equal(layer.id, "request");
    assert.equal(call.toolName, "check_feishu");
    assert.deepEqual(call.input, { scope: "today" });
    return {
      callId: call.id,
      ok: true,
      output: "[2026-05-26 20:00:00] 小王:hello"
    };
  });

  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].content, "");
  assert.equal(messages[0].reasoningContent, "thinking for 小王");
  assert.equal(messages[0].toolCalls?.[0].id, "call_prompt_1");
  assert.equal(messages[0].toolCalls?.[0].function.name, "check_feishu");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].toolCallId, "call_prompt_1");
  assert.equal(messages[1].name, "check_feishu");
  assert.match(messages[1].content, /小王:hello/);
});

function textEvent(): AgentEvent {
  return {
    id: "evt_1",
    source: {
      plugin: "feishu",
      channelId: "chat-1",
      userId: "user-1",
      rawMessageId: "om_1"
    },
    session: {
      scope: "dm",
      sessionId: "session-1"
    },
    type: "message.text",
    payload: { kind: "text", text: "hello" },
    meta: {
      receivedAt: "2026-05-26T00:00:00.000Z"
    }
  };
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
