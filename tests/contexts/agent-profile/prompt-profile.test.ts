import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptMessages,
  buildAppendPromptMessagesWithToolResults,
  buildPromptMessagesWithToolResults,
  createPromptProfileStore,
  defaultPromptProfile,
  staticPromptFingerprint
} from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createPromptToolPreviewRuntime } from "../../../src/contexts/agent-profile/src/application/prompt-tool-preview-runtime.js";
import { promptStoragePath } from "../../../src/contexts/agent-profile/src/adapters/json-prompt-profile-store.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { makeTempDir, messageContentText, promptContext, textEvent } from "./prompt-profile-helpers.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("promptProfileStore_emptyFile_returnsDefaultsWithoutWriting", () => {
  const root = makeTempDir("prompt-store");
  const filePath = promptStoragePath(root, "prompt-profile.json", ["config", "prompt-profile.json"]);
  const store = createPromptProfileStore(filePath);
  const initial = store.get();

  assert.deepEqual(initial.layers, []);
  assert.deepEqual(initial.appendLayers, []);
  assert.equal(initial.interruptLayer?.id, "interrupt");
  assert.equal(initial.interruptLayer?.role, "user");
  assert.equal(initial.interruptLayer?.enabled, true);
  assert.equal(fs.existsSync(filePath), false);
});

test("promptProfileStore_validProfile_persistsEditableLayers", () => {
  const root = makeTempDir("prompt-store-save");
  const filePath = promptStoragePath(root, "prompt-profile.json", ["config", "prompt-profile.json"]);
  const store = createPromptProfileStore(filePath);
  const initial = store.get();
  const saved = store.save({
    ...initial,
    visibleTools: { feishu: false },
    layers: [
      { id: "custom", title: "Custom", role: "system", enabled: true, content: "Hi {{user}} at {{date_time}}", order: 1 }
    ]
  });

  assert.equal(saved.visibleTools.feishu, false);
  assert.equal(createPromptProfileStore(filePath).get().layers[0].content, "Hi {{user}} at {{date_time}}");
  assert.equal(fs.existsSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "prompt-profile.json")), true);
  assert.equal(fs.existsSync(path.join(root, "config", "prompt-profile.json")), false);
});

test("promptProfileStore_interruptLayer_persistsEditableLayer", () => {
  const filePath = path.join(makeTempDir("prompt-store-interrupt"), "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  const initial = store.get();
  const saved = store.save({
    ...initial,
    interruptLayer: {
      id: "interrupt_custom",
      title: "Interrupt",
      role: "user",
      name: "CustomName",
      enabled: true,
      content: "custom interrupt content",
      order: 0
    }
  });

  assert.equal(saved.interruptLayer?.id, "interrupt_custom");
  assert.equal(saved.interruptLayer?.role, "user");
  assert.equal(saved.interruptLayer?.enabled, true);
  const reopened = createPromptProfileStore(filePath).get();
  assert.equal(reopened.interruptLayer?.id, "interrupt_custom");
  assert.equal(reopened.interruptLayer?.role, "user");
  assert.equal(reopened.interruptLayer?.enabled, true);
});

test("promptProfileStore_projectConfigUsername_rejectsProfileField", () => {
  const filePath = path.join(makeTempDir("prompt-store-no-username"), "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  assert.throws(() => store.save({
    ...defaultPromptProfile(),
    userName: "AliceUser"
  } as any), /invalid_prompt_profile_user_name/);
});

test("promptProfileStorage_legacyConfigFile_migratesToAgentProfileFolder", () => {
  const root = makeTempDir("prompt-store-migrate");
  const legacyPath = path.join(root, "config", "prompt-profile.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, `${JSON.stringify(defaultPromptProfile(), null, 2)}\n`);

  const filePath = promptStoragePath(root, "prompt-profile.json", ["config", "prompt-profile.json"]);
  const store = createPromptProfileStore(filePath);

  assert.deepEqual(store.get().layers, []);
  assert.equal(filePath, path.join(root, "src", "contexts", "agent-profile", "prompts", "prompt-profile.json"));
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(legacyPath), false);
});

test("promptProfileStorage_previousRootPromptFile_migratesToAgentProfileFolder", () => {
  const root = makeTempDir("prompt-store-root-migrate");
  const previousPath = path.join(root, "prompt", "prompt-profile.json");
  fs.mkdirSync(path.dirname(previousPath), { recursive: true });
  fs.writeFileSync(previousPath, `${JSON.stringify(defaultPromptProfile(), null, 2)}\n`);

  const filePath = promptStoragePath(root, "prompt-profile.json", ["config", "prompt-profile.json"]);
  const store = createPromptProfileStore(filePath);

  assert.deepEqual(store.get().layers, []);
  assert.equal(filePath, path.join(root, "src", "contexts", "agent-profile", "prompts", "prompt-profile.json"));
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(previousPath), false);
});

test("promptProfileStore_appendLayers_persistsToolRequestLayer", () => {
  const filePath = path.join(makeTempDir("prompt-store-append"), "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  const initial = store.get();
  const saved = store.save({
    ...initial,
    appendLayers: [
      { id: "append", title: "Append", role: "tool_request", enabled: true, content: "", thinking: "look first", toolCalls: [{ toolName: "Chat", toolArguments: "{\"action\":\"poll\"}" }], order: 1 }
    ]
  });

  assert.equal(saved.appendLayers?.[0].thinking, "look first");
  const reopened = createPromptProfileStore(filePath).get();
  assert.equal(reopened.appendLayers?.[0].role, "tool_request");
  assert.equal(reopened.appendLayers?.[0].thinking, "look first");
});

test("promptMessages_variables_rendersConfiguredLayerContent", () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: [
      { id: "one", title: "One", role: "system" as const, enabled: true, content: "{{user}} {{timezone}} {{missing}}", order: 1 }
    ]
  };
  const messages = buildPromptMessages(profile, promptContext({ time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z")) }));

  assert.equal(messages[0].role, "system");
  assert.match(messageContentText(messages[0].content), /小王/);
  assert.match(messageContentText(messages[0].content), /Asia\/Shanghai/);
  assert.match(messageContentText(messages[0].content), /\{\{missing\}\}/);
});

test("promptMessages_layerNames_useParserDefaultsAndConfiguredNames", () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: [
      { id: "default_name", title: "Default Name", role: "user" as const, enabled: true, content: "hello", order: 1 },
      { id: "named", title: "Named", role: "user" as const, name: "{{user}}_speaker", enabled: true, content: "hello", order: 2 },
      { id: "assistant_default", title: "Assistant Default", role: "assistant" as const, enabled: true, content: "", order: 3 },
      { id: "assistant_named", title: "Assistant Named", role: "assistant" as const, name: "Alice", enabled: true, content: "", order: 4 },
      { id: "tool_request_default", title: "Tool Request Default", role: "tool_request" as const, enabled: true, content: "", order: 5, toolCalls: [] }
    ]
  };
  const messages = buildPromptMessages(profile, promptContext({ time: createCurrentTimeProvider("Asia/Shanghai") }));

  assert.equal(messages[0].name, "小王");
  assert.equal(messages[1].name, "小王_speaker");
  assert.equal(messages[2].name, undefined);
  assert.equal(messages[3].name, "Alice");
  assert.equal(messages[4].name, undefined);
});

test("promptMessages_memoryVariables_rendersConfiguredLayerContent", () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: [
      { id: "memory", title: "Memory", role: "system" as const, enabled: true, content: "{{memory/persistent/content}}\n{{memory/userPreferences/content}}\n{{memory/yesterdaySummary/content}}", order: 1 }
    ]
  };
  const messages = buildPromptMessages(profile, promptContext({
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z")),
    memory: {
      persistent: "long fact",
      userPreferences: "likes short replies",
      yesterdaySummary: "yesterday was busy"
    }
  }));

  assert.match(messageContentText(messages[0].content), /long fact/);
  assert.match(messageContentText(messages[0].content), /likes short replies/);
  assert.match(messageContentText(messages[0].content), /yesterday was busy/);
});

test("promptMessages_toolRequestLayer_pairsWithActualToolResult", async () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: [
      {
        id: "request",
        title: "Tool Request",
        role: "tool_request" as const,
        enabled: true,
        content: "",
        thinking: "thinking for {{user}}",
        toolCalls: [{
          toolName: "Chat",
          toolCallId: "call_prompt_1",
          toolArguments: "{\"action\":\"poll\"}"
        }],
        order: 1
      }
    ]
  };

  const messages = await buildPromptMessagesWithToolResults(profile, promptContext({ time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z")) }), async (_layer, call) => {
    return {
      callId: call.id,
      ok: true,
      output: "recent"
    };
  });

  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].content, "");
  assert.equal(messages[0].reasoningContent, "thinking for 小王");
  assert.equal(messages[0].toolCalls?.[0].id, "call_prompt_1");
  assert.equal(messages[0].toolCalls?.[0].function.name, "Chat");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].toolCallId, "call_prompt_1");
  assert.equal(messages[1].name, "Chat");
  assert.equal(messages[1].content, "recent");
});

test("promptMessages_multipleToolCalls_preservesCallOrder", async () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: [{
      id: "request",
      title: "Tool Request",
      role: "tool_request" as const,
      enabled: true,
      content: "",
      toolCalls: [
        { toolName: "Chat", toolCallId: "call_prompt_1", toolArguments: "{\"action\":\"poll\"}" },
        { toolName: "Chat", toolCallId: "call_prompt_2", toolArguments: "{\"query\":\"hi\"}" }
      ],
      order: 1
    }]
  };

  const calls: string[] = [];
  const messages = await buildPromptMessagesWithToolResults(profile, promptContext({ time: createCurrentTimeProvider("Asia/Shanghai") }), async (_layer, call) => {
    calls.push(`${call.id}:${call.toolName}`);
    return { callId: call.id, ok: true, output: call.toolName };
  });

  assert.deepEqual(calls, ["call_prompt_1:Chat", "call_prompt_2:Chat"]);
  assert.deepEqual(messages[0].toolCalls?.map((call) => call.id), ["call_prompt_1", "call_prompt_2"]);
  assert.deepEqual(messages.slice(1).map((message) => message.toolCallId), ["call_prompt_1", "call_prompt_2"]);
});

test("appendPromptMessages_toolRequestLayer_pairsWithActualToolResult", async () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: [],
    appendLayers: [
      {
        id: "append_request",
        title: "Append Tool Request",
        role: "tool_request" as const,
        enabled: true,
        content: "",
        thinking: "append thinking for {{user}}",
        toolCalls: [{
          toolName: "Chat",
          toolCallId: "call_append_1",
          toolArguments: "{\"action\":\"poll\"}"
        }],
        order: 1
      }
    ]
  };

  const messages = await buildAppendPromptMessagesWithToolResults(profile, promptContext({ time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z")) }), async (_layer, call) => {
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

test("promptMessages_ordersEnabledLayers", () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: [
      { id: "second", title: "Second", role: "user" as const, enabled: true, content: "hello", order: 2 },
      { id: "disabled", title: "Disabled", role: "system" as const, enabled: false, content: "look first", order: 0 },
      { id: "first", title: "First", role: "system" as const, enabled: true, content: "static", order: 1 }
    ]
  };
  const messages = buildPromptMessages(profile, promptContext());

  assert.deepEqual(messages.map((message) => message.content), ["static", "hello"]);
});

test("promptPreview_toolRequestLayer_includesToolResult", async () => {
  const time = createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z"));
  const context = promptContext({ time });
  const profile = {
    ...defaultPromptProfile(),
    layers: [{
      id: "request",
      title: "Tool Request",
      role: "tool_request" as const,
      enabled: true,
      content: "",
      thinking: "thinking for {{user}}",
      toolCalls: [{ toolName: "Chat", toolCallId: "call_prompt_1", toolArguments: "{\"action\":\"poll\"}" }],
      order: 1
    }]
  };
  const runTool = async (_layer: unknown, call: any) => ({ callId: call.id, ok: true, output: "recent" });
  const runtime = createPromptToolPreviewRuntime({
    time,
    getPromptRenderer: () => context.renderer,
    toolPlugins: [{
      id: "messaging",
      listTools: () => [{ name: "Chat", description: "", inputSchema: {} }],
      execute: (call: any) => runTool(undefined, call)
    }],
    llmRequests: { buildTools: () => [] },
    messagingTools: { execute: () => undefined }
  });

  const messages = await runtime.buildPromptPreviewMessages(profile, textEvent());

  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].toolCalls?.[0]?.function.name, "Chat");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].content, "recent");
});

test("staticPromptFingerprint_appendLayers_ignoresAppendChanges", () => {
  const time = createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:34:56.000Z"));
  const context = promptContext({ time });
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
