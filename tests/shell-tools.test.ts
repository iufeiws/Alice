import { test } from "node:test";
import assert from "node:assert/strict";
import { createDailyShellStore, type DailyShellStore, type ShellCategory, type ShellOption } from "../src/contexts/agent-profile/src/domain/shell.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { createAliceStore } from "../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createShellTools } from "../src/capabilities/tools/shell/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("wardrobe lists current and available outfits", async () => {
  const root = makeTempDir("wardrobe-list");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two", group: "formal" }
  ]);
  store.switchOutfit(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai", "o2");

  const tools = createShellTools({
    dailyShellStore: store,
    store: createAliceStore(path.join(makeTempDir("wardrobe-list-db"), "alice.sqlite")),
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z"))
  });
  const result = await tools.execute({ id: "call_list", toolName: "Wardrobe", input: { action: "list" } });

  assert.equal(result.ok, true);
  const output = JSON.parse(String(result.output));
  assert.equal(output.current.id, "o2");
  assert.equal(output.outfits.length, 2);
  assert.equal(output.outfits.find((item: any) => item.id === "o2").current, true);

  const filtered = await tools.execute({ id: "call_filter", toolName: "Wardrobe", input: { action: "list", name: "Two" } });
  assert.equal(filtered.ok, true);
  const filteredOutput = JSON.parse(String(filtered.output));
  assert.equal(filteredOutput.query, "Two");
  assert.deepEqual(filteredOutput.outfits.map((item: any) => item.name), ["O Two"]);

  const groupFiltered = await tools.execute({ id: "call_filter_group", toolName: "Wardrobe", input: { action: "list", name: "formal" } });
  assert.equal(groupFiltered.ok, true);
  const groupFilteredOutput = JSON.parse(String(groupFiltered.output));
  assert.equal(groupFilteredOutput.query, "formal");
  assert.deepEqual(groupFilteredOutput.outfits.map((item: any) => item.name), ["O Two"]);
});

test("wardrobe mirror returns the current outfit without messaging target", async () => {
  const root = makeTempDir("wardrobe-mirror");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  store.switchOutfit(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai", "o2");

  const sent: unknown[] = [];
  const tools = createShellTools({
    dailyShellStore: store,
    store: createAliceStore(path.join(makeTempDir("wardrobe-mirror-db"), "alice.sqlite")),
    outputRouter: {
      async send(output) {
        sent.push(output);
      }
    },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z"))
  });

  const result = await tools.execute({ id: "call_mirror", toolName: "Wardrobe", input: { action: "mirror" } });

  assert.equal(result.ok, true);
  assert.equal(result.output, "你看到镜子中的自己穿着: \n 服装：O Two\noutfit two");
  assert.deepEqual(sent, []);
});

test("wardrobe switches outfit without shell switch messages or logs", async () => {
  const root = makeTempDir("wardrobe-switch");
  const shellStore = createDailyShellStore(root);
  replaceShellCategory(root, shellStore, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, shellStore, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, shellStore, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const store = createAliceStore(path.join(makeTempDir("wardrobe-switch-db"), "alice.sqlite"));
  const logs: unknown[] = [];
  const sent: unknown[] = [];
  const tools = createShellTools({
    dailyShellStore: shellStore,
    store,
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "sent_change_notice" };
      }
    },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z")),
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog(input) {
      logs.push(input);
    }
  });

  const result = await tools.execute({ id: "call_switch", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, true);
  assert.equal(result.invalidateLLMSession, undefined);
  assert.equal(shellStore.get(new Date("2026-05-26T12:31:00.000Z"), "Asia/Shanghai").outfit.id, "o2");
  const switchLogs = shellStore.listSwitchLogs();
  assert.equal(switchLogs.length, 1);
  const messages = store.listMessagesForConversation("session-1", 10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderRole, "system");
  assert.equal(messages[0].status, "sent");
  assert.equal(messages[0].contentText, "-少女已更衣-");
  assert.equal((sent[0] as any).content.text, "-少女已更衣-");
  assert.deepEqual(logs, [{
    direction: "outbound",
    plugin: "feishu",
    kind: "text",
    target: "chat-1",
    sessionId: "session-1",
    status: "sent",
    summary: "-少女已更衣-"
  }]);
  const output = JSON.parse(String(result.output));
  assert.equal(output.message, "服装已切换为O Two");
  assert.equal(output.rendered, undefined);
  assert.doesNotMatch(messages[0].contentText, /壳|切换为O Two/);
});

test("wardrobe switch requires a current target and known outfit name", async () => {
  const root = makeTempDir("wardrobe-errors");
  const shellStore = createDailyShellStore(root);
  replaceShellCategory(root, shellStore, "outfits", [{ id: "o1", name: "O One", content: "outfit one" }]);
  const tools = createShellTools({
    dailyShellStore: shellStore,
    store: createAliceStore(path.join(makeTempDir("wardrobe-errors-db"), "alice.sqlite")),
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z"))
  });

  const noTarget = await tools.execute({ id: "call_no_target", toolName: "Wardrobe", input: { action: "switch", name: "O One" } });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.error ?? "", /No current messaging session/);

  const withTarget = createShellTools({
    dailyShellStore: shellStore,
    store: createAliceStore(path.join(makeTempDir("wardrobe-errors-db-2"), "alice.sqlite")),
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z")),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const unknown = await withTarget.execute({ id: "call_unknown", toolName: "Wardrobe", input: { action: "switch", name: "missing" } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /unknown outfit name/);
});

test("wardrobe switch reports changing notice send failures", async () => {
  const root = makeTempDir("wardrobe-send-failed");
  const shellStore = createDailyShellStore(root);
  replaceShellCategory(root, shellStore, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const store = createAliceStore(path.join(makeTempDir("wardrobe-send-failed-db"), "alice.sqlite"));
  const logs: unknown[] = [];
  const tools = createShellTools({
    dailyShellStore: shellStore,
    store,
    outputRouter: {
      async send() {
        throw new Error("send unavailable");
      }
    },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z")),
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog(input) {
      logs.push(input);
    }
  });

  const result = await tools.execute({ id: "call_send_failed", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /send unavailable/);
  const messages = store.listMessagesForConversation("session-1", 10);
  assert.equal(messages[0].contentText, "-少女已更衣-");
  assert.equal(messages[0].status, "send_failed");
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
  const root = makeTempDir("wardrobe-on-body-attempt");
  const shellStore = createDailyShellStore(root);
  replaceShellCategory(root, shellStore, "outfits", [
    { id: "o1", name: "O One", content: "outfit one", onBodyGenerationAttempted: true },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);
  const attempted: string[] = [];
  const tools = createShellTools({
    dailyShellStore: shellStore,
    store: createAliceStore(path.join(makeTempDir("wardrobe-on-body-attempt-db"), "alice.sqlite")),
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z")),
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
  assert.equal(JSON.parse(String(first.output)).current.onBodyGenerationAttempted, true);
});

test("wardrobe switch skips on-body generation for generated outfit images", async () => {
  const root = makeTempDir("wardrobe-on-body-generated-skip");
  const shellStore = createDailyShellStore(root);
  replaceShellCategory(root, shellStore, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two", outfitImageGenerated: true }
  ]);
  const attempted: string[] = [];
  const tools = createShellTools({
    dailyShellStore: shellStore,
    store: createAliceStore(path.join(makeTempDir("wardrobe-on-body-generated-skip-db"), "alice.sqlite")),
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z")),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" }),
    attemptOnBodyGeneration(outfit) {
      attempted.push(outfit.id);
    }
  });

  const result = await tools.execute({ id: "call_switch_generated_skip", toolName: "Wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, true);
  assert.deepEqual(attempted, []);
  assert.equal(JSON.parse(String(result.output)).current.onBodyGenerationAttempted, true);
});

test("wardrobe switch returns candidates for ambiguous names", async () => {
  const root = makeTempDir("wardrobe-ambiguous");
  const shellStore = createDailyShellStore(root);
  replaceShellCategory(root, shellStore, "outfits", [
    { id: "maid_black", name: "黑色女仆装", content: "black maid outfit" },
    { id: "maid_white", name: "白色女仆装", content: "white maid outfit" }
  ]);
  const tools = createShellTools({
    dailyShellStore: shellStore,
    store: createAliceStore(path.join(makeTempDir("wardrobe-ambiguous-db"), "alice.sqlite")),
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z")),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_ambiguous", toolName: "Wardrobe", input: { action: "switch", name: "女仆" } });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ambiguous outfit name/);
  const output = JSON.parse(String(result.output));
  assert.deepEqual(output.candidates.map((item: any) => item.name).sort(), ["白色女仆装", "黑色女仆装"].sort());
});

function replaceShellCategory(root: string, store: DailyShellStore, category: ShellCategory, options: ShellOption[]): void {
  const dir = path.join(root, "shell", category);
  if (fs.existsSync(dir)) {
    for (const fileName of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, fileName));
    }
  }
  for (const option of options) {
    store.saveOption(category, option);
  }
}

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
