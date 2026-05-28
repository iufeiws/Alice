import { test } from "node:test";
import assert from "node:assert/strict";
import { createDailyShellStore, type DailyShellStore, type ShellCategory, type ShellOption } from "../core/agent/src/shells.js";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";
import { createShellTools } from "../plugins/shell/src/index.js";

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
  const result = await tools.execute({ id: "call_list", toolName: "wardrobe", input: { action: "list" } });

  assert.equal(result.ok, true);
  const output = JSON.parse(String(result.output));
  assert.equal(output.current.id, "o2");
  assert.equal(output.outfits.length, 2);
  assert.equal(output.outfits.find((item: any) => item.id === "o2").current, true);

  const filtered = await tools.execute({ id: "call_filter", toolName: "wardrobe", input: { action: "list", name: "Two" } });
  assert.equal(filtered.ok, true);
  const filteredOutput = JSON.parse(String(filtered.output));
  assert.equal(filteredOutput.query, "Two");
  assert.deepEqual(filteredOutput.outfits.map((item: any) => item.name), ["O Two"]);
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

  const result = await tools.execute({ id: "call_switch", toolName: "wardrobe", input: { action: "switch", name: "O Two" } });

  assert.equal(result.ok, true);
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
  assert.match(String(result.output), /服装已切换为O Two/);
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

  const noTarget = await tools.execute({ id: "call_no_target", toolName: "wardrobe", input: { action: "switch", name: "O One" } });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.error ?? "", /No current messaging session/);

  const withTarget = createShellTools({
    dailyShellStore: shellStore,
    store: createAliceStore(path.join(makeTempDir("wardrobe-errors-db-2"), "alice.sqlite")),
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:30:00.000Z")),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const unknown = await withTarget.execute({ id: "call_unknown", toolName: "wardrobe", input: { action: "switch", name: "missing" } });
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

  const result = await tools.execute({ id: "call_send_failed", toolName: "wardrobe", input: { action: "switch", name: "O Two" } });

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

  const result = await tools.execute({ id: "call_ambiguous", toolName: "wardrobe", input: { action: "switch", name: "女仆" } });
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
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
