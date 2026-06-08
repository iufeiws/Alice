import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptMessages,
  buildAppendPromptMessagesWithToolResults,
  buildPromptMessagesWithToolResults,
  createPromptProfileStore,
  defaultPromptProfile,
  staticPromptFingerprint
} from "../src/core/agent/src/prompts.js";
import { createDailyShellStore, type DailyShellStore, type ShellCategory, type ShellOption } from "../src/core/agent/src/shells.js";
import { promptStoragePath } from "../src/core/agent/src/prompt-storage.js";
import { createCurrentTimeProvider } from "../src/core/time/src/index.js";
import type { AgentEvent } from "../src/packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("prompt profile store creates defaults and persists edits", () => {
  const root = makeTempDir("prompt-store");
  const filePath = promptStoragePath(root, "prompt-profile.json", ["config", "prompt-profile.json"]);
  const store = createPromptProfileStore(filePath);
  const initial = store.get();
  assert.equal(initial.userName, "user");
  assert.deepEqual(initial.layers.map((layer) => layer.title), [
    "安全边际",
    "角色设定",
    "职责",
    "Skill",
      "记忆",
    "壳设定 + DeepSeek Role Immersion"
  ]);

  const saved = store.save({
    ...initial,
    userName: "AliceUser",
    visibleTools: { feishu: false },
    layers: [
      { id: "custom", title: "Custom", role: "system", enabled: true, content: "Hi {{user}} at {{date_time}}", order: 1 }
    ]
  });
  assert.equal(saved.userName, "AliceUser");
  assert.equal(saved.visibleTools.feishu, false);

  const reopened = createPromptProfileStore(filePath).get();
  assert.equal(reopened.userName, "AliceUser");
  assert.equal(reopened.layers[0].content, "Hi {{user}} at {{date_time}}");
  assert.equal(fs.existsSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "prompt-profile.json")), true);
  assert.equal(fs.existsSync(path.join(root, "config", "prompt-profile.json")), false);
});

test("prompt profile storage migrates legacy config file to agent-profile prompts folder", () => {
  const root = makeTempDir("prompt-store-migrate");
  const legacyPath = path.join(root, "config", "prompt-profile.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, `${JSON.stringify({
    ...defaultPromptProfile(),
    userName: "LegacyUser"
  }, null, 2)}\n`);

  const filePath = promptStoragePath(root, "prompt-profile.json", ["config", "prompt-profile.json"]);
  const store = createPromptProfileStore(filePath);

  assert.equal(store.get().userName, "LegacyUser");
  assert.equal(filePath, path.join(root, "src", "contexts", "agent-profile", "prompts", "prompt-profile.json"));
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(legacyPath), false);
});

test("prompt profile storage migrates previous root prompt file to agent-profile prompts folder", () => {
  const root = makeTempDir("prompt-store-root-migrate");
  const previousPath = path.join(root, "prompt", "prompt-profile.json");
  fs.mkdirSync(path.dirname(previousPath), { recursive: true });
  fs.writeFileSync(previousPath, `${JSON.stringify({
    ...defaultPromptProfile(),
    userName: "PreviousRootUser"
  }, null, 2)}\n`);

  const filePath = promptStoragePath(root, "prompt-profile.json", ["config", "prompt-profile.json"]);
  const store = createPromptProfileStore(filePath);

  assert.equal(store.get().userName, "PreviousRootUser");
  assert.equal(filePath, path.join(root, "src", "contexts", "agent-profile", "prompts", "prompt-profile.json"));
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(previousPath), false);
});

test("prompt profile persists append layers", () => {
  const filePath = path.join(makeTempDir("prompt-store-append"), "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  const initial = store.get();
  const saved = store.save({
    ...initial,
    appendLayers: [
      { id: "append", title: "Append", role: "tool_request", enabled: true, content: "", thinking: "look first", toolName: "check_chat", toolArguments: "{}", order: 1 }
    ]
  });

  assert.equal(saved.appendLayers?.[0].thinking, "look first");
  const reopened = createPromptProfileStore(filePath).get();
  assert.equal(reopened.appendLayers?.[0].role, "tool_request");
  assert.equal(reopened.appendLayers?.[0].thinking, "look first");
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

test("prompt messages render memory variables", () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: [
      { id: "memory", title: "Memory", role: "system" as const, enabled: true, content: "{{memory/persistent/content}}\n{{memory/userPreferences/content}}\n{{memory/yesterdaySummary/content}}", order: 1 }
    ]
  };
  const messages = buildPromptMessages(profile, {
    event: textEvent(),
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z")),
    memory: {
      persistent: "long fact",
      userPreferences: "likes short replies",
      yesterdaySummary: "yesterday was busy"
    }
  });

  assert.match(messages[0].content, /long fact/);
  assert.match(messages[0].content, /likes short replies/);
  assert.match(messages[0].content, /yesterday was busy/);
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
        toolName: "check_chat",
        toolCallId: "call_prompt_1",
        toolArguments: "{}",
        order: 1
      }
    ]
  };

  const messages = await buildPromptMessagesWithToolResults(profile, {
    event: textEvent(),
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z"))
  }, async (layer, call) => {
    assert.equal(layer.id, "request");
    assert.equal(call.toolName, "check_chat");
    assert.deepEqual(call.input, {});
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
  assert.equal(messages[0].toolCalls?.[0].function.name, "check_chat");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].toolCallId, "call_prompt_1");
  assert.equal(messages[1].name, "check_chat");
  assert.match(messages[1].content, /小王:hello/);
});

test("append prompt messages pair tool request layers with actual tool results", async () => {
  const profile = {
    ...defaultPromptProfile(),
    userName: "小王",
    layers: [],
    appendLayers: [
      {
        id: "append_request",
        title: "Append Tool Request",
        role: "tool_request" as const,
        enabled: true,
        content: "",
        thinking: "append thinking for {{user}}",
        toolName: "check_chat",
        toolCallId: "call_append_1",
        toolArguments: "{}",
        order: 1
      }
    ]
  };

  const messages = await buildAppendPromptMessagesWithToolResults(profile, {
    event: textEvent(),
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z"))
  }, async (layer, call) => {
    assert.equal(layer.id, "append_request");
    assert.equal(call.toolName, "check_chat");
    return {
      callId: call.id,
      ok: true,
      output: "recent"
    };
  });

  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].reasoningContent, "append thinking for 小王");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].content, "recent");
});

test("static prompt fingerprint ignores append layers but tracks initial layer changes", () => {
  const time = createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z"));
  const context = { event: textEvent(), time };
  const base = {
    ...defaultPromptProfile(),
    layers: [
      { id: "static", title: "Static", role: "system" as const, enabled: true, content: "static", order: 1 }
    ],
    appendLayers: [
      { id: "append", title: "Append", role: "user" as const, enabled: true, content: "append one", order: 1 }
    ]
  };
  const changedAppend = {
    ...base,
    appendLayers: [
      { ...base.appendLayers[0], content: "append two" }
    ]
  };
  const changedStatic = {
    ...base,
    layers: [
      { ...base.layers[0], content: "static changed" }
    ]
  };

  assert.equal(staticPromptFingerprint(base, context), staticPromptFingerprint(changedAppend, context));
  assert.notEqual(staticPromptFingerprint(base, context), staticPromptFingerprint(changedStatic, context));
});

test("daily shell store creates category files and reuses one shell per day", () => {
  const root = makeTempDir("daily-shell");
  const store = createDailyShellStore(root);
  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  const second = store.get(new Date("2026-05-26T15:59:59.000Z"), "Asia/Shanghai");
  const shellDir = path.join(root, "shell");

  assert.equal(first.date, "2026-05-26");
  assert.equal(second.date, "2026-05-26");
  assert.equal(second.personality.id, first.personality.id);
  assert.equal(second.relationship.id, first.relationship.id);
  assert.equal(second.outfit.id, first.outfit.id);
  assert.equal(fs.readdirSync(path.join(shellDir, "personalities")).filter((item) => item.endsWith(".json")).length >= 10, true);
  assert.equal(fs.readdirSync(path.join(shellDir, "relationships")).filter((item) => item.endsWith(".json")).length >= 10, true);
  assert.equal(fs.readdirSync(path.join(shellDir, "outfits")).filter((item) => item.endsWith(".json")).length >= 10, true);
  assert.equal(fs.existsSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "shell-prompt-template.txt")), true);
  assert.equal(fs.existsSync(path.join(shellDir, "prompt-template.txt")), false);
  assert.match(fs.readFileSync(path.join(shellDir, "daily-shell.json"), "utf8"), /rendered/);
  assert.match(store.render(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai"), /爱丽丝今日的\*外壳\*是/);
});

test("daily shell store preserves outfit image urls", () => {
  const root = makeTempDir("daily-shell-image");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "outfits", [
    { id: "custom_outfit", name: "Custom Outfit", content: "custom content", group: "fantasy", imageUrl: "memory-files/shell/assets/custom.png" }
  ]);

  assert.equal(fs.existsSync(path.join(root, "shell", "outfits", "custom_outfit.json")), true);
  const config = store.getConfig(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  assert.equal(config.outfits[0].imageUrl, "memory-files/shell/assets/custom.png");
  assert.equal(config.outfits[0].group, "fantasy");
  assert.doesNotMatch(store.render(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai"), /图片地址:/);
});

test("daily shell prompt template is editable", () => {
  const root = makeTempDir("daily-shell-prompt");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [
    { id: "p2", name: "P Two", content: "personality two" },
    { id: "p1", name: "P One", content: "personality one" }
  ]);
  store.savePromptTemplate("P={{personality_name}}\nR={{relationship_name}}\nO={{outfit_name}}");

  const config = store.getConfig(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  assert.equal(config.personalities[0].id, "p1");
  assert.equal(config.promptTemplate, "P={{personality_name}}\nR={{relationship_name}}\nO={{outfit_name}}");
  assert.equal(fs.readFileSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "shell-prompt-template.txt"), "utf8"), "P={{personality_name}}\nR={{relationship_name}}\nO={{outfit_name}}\n");
  assert.match(config.rendered, /^P=/);
});

test("daily shell prompt template migrates from legacy shell folder", () => {
  const root = makeTempDir("daily-shell-prompt-migrate");
  const legacyPath = path.join(root, "shell", "prompt-template.txt");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, "Legacy={{outfit_name}}\n");

  const store = createDailyShellStore(root);
  const config = store.getConfig(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");

  assert.equal(config.promptTemplate, "Legacy={{outfit_name}}");
  assert.equal(fs.existsSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "shell-prompt-template.txt")), true);
  assert.equal(fs.existsSync(legacyPath), false);
  assert.match(config.rendered, /^Legacy=/);
});

test("daily shell remains stable when the active option is edited", () => {
  const root = makeTempDir("daily-shell-stable");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [
    { id: "p1", name: "P One", content: "personality one" }
  ]);
  replaceShellCategory(root, store, "relationships", [
    { id: "r1", name: "R One", content: "relationship one" }
  ]);
  replaceShellCategory(root, store, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" }
  ]);

  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  store.saveOption("personalities", { id: "p2", name: "P Two", content: "personality two" }, "p1");
  const second = store.get(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai");

  assert.equal(first.relationship.id, second.relationship.id);
  assert.equal(first.outfit.id, second.outfit.id);
  assert.equal(second.personality.id, "p2");
  assert.equal(store.render(new Date("2026-05-26T14:00:00.000Z"), "Asia/Shanghai"), store.render(new Date("2026-05-26T15:00:00.000Z"), "Asia/Shanghai"));
});

test("daily shell can switch only the active outfit", () => {
  const root = makeTempDir("daily-shell-switch-outfit");
  const switchEvents: string[] = [];
  const store = createDailyShellStore(root, {
    onSwitch(entry) {
      switchEvents.push(entry.outfitName);
    }
  });
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);

  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  const switchLogCount = store.listSwitchLogs().length;
  const switchEventCount = switchEvents.length;
  const switched = store.switchOutfit(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai", "o2");

  assert.equal(switched.personality.id, first.personality.id);
  assert.equal(switched.relationship.id, first.relationship.id);
  assert.equal(switched.outfit.id, "o2");
  assert.equal(switched.date, first.date);
  assert.equal(switched.createdAt, first.createdAt);
  assert.match(fs.readFileSync(path.join(root, "shell", "daily-shell.json"), "utf8"), /"outfitId": "o2"/);
  assert.equal(store.listSwitchLogs().length, switchLogCount);
  assert.equal(switchEvents.length, switchEventCount);
  assert.throws(() => store.switchOutfit(new Date("2026-05-26T14:00:00.000Z"), "Asia/Shanghai", "missing"), /unknown_outfit/);
  assert.equal(store.get(new Date("2026-05-26T15:00:00.000Z"), "Asia/Shanghai").outfit.id, "o2");
});

test("daily shell stays stable until an explicit wake reroll", () => {
  const root = makeTempDir("daily-shell-wake-reroll");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [{ id: "o1", name: "O One", content: "outfit one" }]);
  store.saveSettings({ rolloverHour: 4 });

  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  const before = store.get(new Date("2026-05-26T19:59:00.000Z"), "Asia/Shanghai");
  const after = store.get(new Date("2026-05-26T20:00:00.000Z"), "Asia/Shanghai");
  const woke = store.reroll(new Date("2026-05-26T20:01:00.000Z"), "Asia/Shanghai");

  assert.equal(first.date, "2026-05-26");
  assert.equal(before.createdAt, first.createdAt);
  assert.equal(after.createdAt, first.createdAt);
  assert.equal(woke.date, "2026-05-27");
  assert.notEqual(woke.createdAt, first.createdAt);
  assert.equal(store.getSettings().rolloverHour, 4);
});

test("daily shell reroll avoids recently used relationship identities", () => {
  const root = makeTempDir("daily-shell-recent-relationships");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [
    { id: "r1", name: "A One", content: "relationship one" },
    { id: "r2", name: "B Two", content: "relationship two" },
    { id: "r3", name: "C Three", content: "relationship three" }
  ]);
  replaceShellCategory(root, store, "outfits", [{ id: "o1", name: "O One", content: "outfit one" }]);

  const originalRandom = Math.random;
  const randomValues = [
    0, 0, 0,
    0.9, 0, 0,
    0.9, 0, 0,
    0.9, 0, 0
  ];
  Math.random = () => randomValues.shift() ?? 0;
  try {
    const first = store.reroll(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
    const reopened = createDailyShellStore(root);
    const second = reopened.reroll(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai");
    const third = reopened.reroll(new Date("2026-05-26T14:00:00.000Z"), "Asia/Shanghai");
    const fourth = reopened.reroll(new Date("2026-05-26T15:00:00.000Z"), "Asia/Shanghai");

    assert.deepEqual(
      [first.relationship.id, second.relationship.id, third.relationship.id, fourth.relationship.id],
      ["r1", "r3", "r2", "r3"]
    );
    assert.deepEqual(
      [first.personality.id, second.personality.id, third.personality.id, fourth.personality.id],
      ["p1", "p1", "p1", "p1"]
    );
  } finally {
    Math.random = originalRandom;
  }

  const record = JSON.parse(fs.readFileSync(path.join(root, "shell", "daily-shell.json"), "utf8")) as {
    recentRelationshipIds?: string[];
  };
  assert.deepEqual(record.recentRelationshipIds, ["r3"]);
});

test("daily shell store records shell switch logs", () => {
  const root = makeTempDir("daily-shell-switch-log");
  const switchEvents: string[] = [];
  const store = createDailyShellStore(root, {
    onSwitch(entry) {
      switchEvents.push(entry.message);
    }
  });
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "冷淡", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "同桌", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [{ id: "o1", name: "制服", content: "outfit one" }]);
  store.saveSettings({ rolloverHour: 4 });

  store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  store.get(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai");
  store.get(new Date("2026-05-26T20:00:00.000Z"), "Asia/Shanghai");
  store.reroll(new Date("2026-05-26T20:00:00.000Z"), "Asia/Shanghai");

  const logs = store.listSwitchLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].time, "2026-05-26T20:00:00.000");
  assert.equal(logs[1].time, "2026-05-27T04:00:00.000");
  assert.doesNotMatch(logs[0].time, /Z$|[+-]\d{2}:\d{2}$/);
  assert.doesNotMatch(logs[1].time, /Z$|[+-]\d{2}:\d{2}$/);
  assert.equal(logs[0].message, "切换到冷淡的同桌爱丽丝");
  assert.equal(logs[1].message, "切换到冷淡的同桌爱丽丝");
  assert.deepEqual(switchEvents, [
    "切换到冷淡的同桌爱丽丝",
    "切换到冷淡的同桌爱丽丝"
  ]);
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
