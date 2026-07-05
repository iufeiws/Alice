import { test } from "node:test";
import assert from "node:assert/strict";
import { createAliceStore } from "../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { makeShellStore, makeShellTools, makeTempDir } from "./shell-tools-helpers.js";

const path = await import("node:path");

test("wardrobe switch updates shell store", async () => {
  const shellStore = makeShellStore("wardrobe-switch-store", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const tools = makeShellTools("wardrobe-switch-store", shellStore, {
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_switch", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, true);
  assert.equal(shellStore.get(new Date("2026-05-26T12:31:00.000Z"), "Asia/Shanghai").outfit.id, "o2");
  assert.equal(shellStore.listSwitchLogs().length, 1);
});

test("wardrobe switch sends changing notice", async () => {
  const shellStore = makeShellStore("wardrobe-switch-store", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const sent: unknown[] = [];
  const tools = makeShellTools("wardrobe-switch-store", shellStore, {
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "sent_change_notice" };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog() {}
  });

  const result = await tools.execute({ id: "call_switch", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, true);
  assert.equal((sent[0] as any).content.text, "-少女已更衣-");
});

test("wardrobe switch logs sent changing notice", async () => {
  const shellStore = makeShellStore("wardrobe-switch-log", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const logs: unknown[] = [];
  const tools = makeShellTools("wardrobe-switch-log", shellStore, {
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog(input) {
      logs.push(input);
    }
  });

  await tools.execute({ id: "call_switch", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.deepEqual(logs, [{
    direction: "outbound",
    plugin: "feishu",
    kind: "text",
    target: "chat-1",
    sessionId: "session-1",
    status: "sent",
    summary: "-少女已更衣-"
  }]);
});

test("wardrobe switch stores sent changing notice in message state", async () => {
  const shellStore = makeShellStore("wardrobe-switch-message", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const store = createAliceStore(path.join(makeTempDir("wardrobe-switch-message-db"), "alice.sqlite"));
  const tools = makeShellTools("wardrobe-switch-message", shellStore, {
    store,
    outputRouter: {
      async send() {
        return { messageId: "sent_change_notice" };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog() {}
  });

  await tools.execute({ id: "call_switch", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  const messages = store.listMessagesForConversation("session-1", 10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderRole, "system");
  assert.equal(messages[0].status, "sent");
  assert.equal(messages[0].contentText, "-少女已更衣-");
});

test("wardrobe switch keeps failed changing notice in message state", async () => {
  const shellStore = makeShellStore("wardrobe-send-failed", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const store = createAliceStore(path.join(makeTempDir("wardrobe-send-failed-db"), "alice.sqlite"));
  const tools = makeShellTools("wardrobe-send-failed", shellStore, {
    store,
    outputRouter: {
      async send() {
        throw new Error("send unavailable");
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog() {}
  });

  const result = await tools.execute({ id: "call_send_failed", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /send unavailable/);
  const messages = store.listMessagesForConversation("session-1", 10);
  assert.equal(messages[0].contentText, "-少女已更衣-");
  assert.equal(messages[0].status, "send_failed");
});

test("wardrobe switch logs failed changing notice", async () => {
  const shellStore = makeShellStore("wardrobe-send-failed-log", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const logs: unknown[] = [];
  const tools = makeShellTools("wardrobe-send-failed-log", shellStore, {
    outputRouter: {
      async send() {
        throw new Error("send unavailable");
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog(input) {
      logs.push(input);
    }
  });

  await tools.execute({ id: "call_send_failed", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.deepEqual(logs, [{
    direction: "outbound",
    plugin: "feishu",
    kind: "text",
    target: "chat-1",
    sessionId: "session-1",
    status: "send_failed",
    summary: "-少女已更衣-",
    error: "send unavailable"
  }]);
});

test("wardrobe switch attempts on-body generation once for unattempted outfits", async () => {
  const shellStore = makeShellStore("wardrobe-on-body-attempt", [
    { id: "o1", name: "O One", content: "outfit one", onBodyGenerationAttempted: true },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const attempted: string[] = [];
  const tools = makeShellTools("wardrobe-on-body-attempt", shellStore, {
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" }),
    attemptOnBodyGeneration(outfit) {
      attempted.push(outfit.id);
      shellStore.saveOption("outfits", { ...outfit, onBodyGenerationAttempted: true }, outfit.id);
    }
  });

  const first = await tools.execute({ id: "call_switch_attempt", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });
  const second = await tools.execute({ id: "call_switch_skip", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(attempted, ["o2"]);
  assert.equal(shellStore.get(new Date("2026-05-26T12:31:00.000Z"), "Asia/Shanghai").outfit.onBodyGenerationAttempted, true);
});

test("wardrobe switch skips on-body generation for generated outfit images", async () => {
  const shellStore = makeShellStore("wardrobe-on-body-generated-skip", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two", outfitImageGenerated: true }
  ]);
  const attempted: string[] = [];
  const tools = makeShellTools("wardrobe-on-body-generated-skip", shellStore, {
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" }),
    attemptOnBodyGeneration(outfit) {
      attempted.push(outfit.id);
    }
  });

  const result = await tools.execute({ id: "call_switch_generated_skip", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, true);
  assert.deepEqual(attempted, []);
  assert.equal(shellStore.get(new Date("2026-05-26T12:31:00.000Z"), "Asia/Shanghai").outfit.onBodyGenerationAttempted, true);
});
