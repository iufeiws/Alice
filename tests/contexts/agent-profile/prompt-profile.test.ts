import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAppendPromptMessagesWithToolResults,
  buildPromptMessages,
  buildPromptMessagesWithToolResults,
  createPromptProfileStore,
  defaultPromptProfile,
  staticPromptFingerprint,
  type PromptLayer,
  type PromptMessage
} from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createPromptToolPreviewRuntime } from "../../../src/contexts/agent-profile/src/application/prompt-tool-preview-runtime.js";
import { promptStoragePath } from "../../../src/contexts/agent-profile/src/adapters/json-prompt-profile-store.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { makeTempDir, promptContext, textEvent } from "./prompt-profile-helpers.js";

const fs = await import("node:fs");
const path = await import("node:path");

const layer = (...messages: PromptMessage[]): PromptLayer => ({ meta: {}, messages });
const message = (title: string, role: PromptMessage["role"], content: string, enabled = true): PromptMessage => ({
  meta: { title, enabled }, role, content
});

test("promptProfileStore_emptyFile_returnsDefaultsWithoutWriting", () => {
  const filePath = promptStoragePath(makeTempDir("prompt-store"), "prompt-profile.json");
  createPromptProfileStore(filePath).get();
  assert.equal(fs.existsSync(filePath), false);
});

test("promptProfileStore_validProfile_persistsLayerDocuments", () => {
  const root = makeTempDir("prompt-store-save");
  const filePath = promptStoragePath(root, "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  const saved = store.save({
    ...store.get(),
    visibleTools: { feishu: false },
    layers: layer(message("Custom", "system", "Hi ${{user}} at ${{date_time}}"))
  });

  assert.equal(saved.visibleTools.feishu, false);
  assert.equal(createPromptProfileStore(filePath).get().layers.messages[0].content, "Hi ${{user}} at ${{date_time}}");
  assert.equal(fs.existsSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "prompt-profile.json")), true);
  assert.equal(fs.existsSync(path.join(root, "config", "prompt-profile.json")), false);
});

test("promptProfileStore_interruptLayer_persistsMessages", () => {
  const filePath = path.join(makeTempDir("prompt-store-interrupt"), "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  const interrupt = { ...message("Interrupt", "user", "custom interrupt content"), name: "CustomName" };
  store.save({ ...store.get(), interruptLayer: layer(interrupt) });

  const reopened = createPromptProfileStore(filePath).get().interruptLayer!;
  assert.equal(reopened.messages[0].meta.title, "Interrupt");
  assert.equal(reopened.messages[0].name, "CustomName");
});

test("promptProfileStore_messageDeliveryReminderLayer_acceptsOnlyUserMessages", () => {
  const filePath = path.join(makeTempDir("prompt-store-message-delivery-reminder"), "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  const saved = store.save({
    ...store.get(),
    messageDeliveryReminderLayer: layer(message("Reminder", "user", "configured reminder"))
  });

  assert.equal(saved.messageDeliveryReminderLayer?.messages[0]?.role, "user");
  assert.throws(() => store.save({
    ...store.get(),
    messageDeliveryReminderLayer: layer(message("Reminder", "system", "invalid reminder"))
  }), /invalid_prompt_message_delivery_reminder_role/);
});

test("promptProfileStore_projectConfigUsername_rejectsProfileField", () => {
  const filePath = path.join(makeTempDir("prompt-store-no-username"), "prompt-profile.json");
  assert.throws(() => createPromptProfileStore(filePath).save({
    ...defaultPromptProfile(), userName: "AliceUser"
  } as any), /invalid_prompt_profile_user_name/);
});

test("promptProfileStore_appendLayers_persistsAssistantToolCalls", () => {
  const filePath = path.join(makeTempDir("prompt-store-append"), "prompt-profile.json");
  const store = createPromptProfileStore(filePath);
  const toolMessage: PromptMessage = {
    ...message("Append", "assistant", ""),
    reasoningContent: "look first",
    toolCalls: [{ id: "call_append_1", type: "function", function: { name: "Chat", arguments: "{\"action\":\"poll\"}" } }]
  };
  store.save({ ...store.get(), appendLayers: layer(toolMessage) });

  const reopened = createPromptProfileStore(filePath).get().appendLayers!.messages[0];
  assert.equal(reopened.role, "assistant");
  assert.equal(reopened.reasoningContent, "look first");
  assert.equal(reopened.toolCalls?.[0].function.name, "Chat");
});

test("promptMessages_names_areStoredMessageFields", () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: layer(
      message("Unnamed", "user", "hello"),
      { ...message("Named", "user", "hello"), name: "${{user}}_speaker" },
      { ...message("Assistant", "assistant", ""), name: "Alice" }
    )
  };
  const messages = buildPromptMessages(profile, promptContext({ time: createCurrentTimeProvider("Asia/Shanghai") }));

  assert.equal(messages[0].name, undefined);
  assert.equal(messages[1].name, "小王_speaker");
  assert.equal(messages[2].name, "Alice");
});

test("promptMessages_assistantToolCalls_pairWithActualToolResults", async () => {
  const toolMessage: PromptMessage = {
    ...message("Tool Request", "assistant", ""),
    reasoningContent: "thinking for ${{user}}",
    toolCalls: [{ id: "call_prompt_1", type: "function", function: { name: "Chat", arguments: "{\"action\":\"poll\"}" } }]
  };
  const messages = await buildPromptMessagesWithToolResults(
    { ...defaultPromptProfile(), layers: layer(toolMessage) },
    promptContext({ time: createCurrentTimeProvider("Asia/Shanghai") }),
    async (_message, call) => ({ callId: call.id, ok: true, output: "recent" })
  );

  assert.equal(messages[0].reasoningContent, "thinking for 小王");
  assert.equal(messages[0].toolCalls?.[0].id, "call_prompt_1");
  assert.deepEqual(messages[1], { role: "tool", name: "Chat", toolCallId: "call_prompt_1", content: "recent" });
});

test("promptMessages_toolResult_passesThroughRenderTextOnlyWhenToolProfileEnablesIt", async () => {
  const toolMessage: PromptMessage = {
    ...message("Tool Request", "assistant", ""),
    toolCalls: [{ id: "call_prompt_render_1", type: "function", function: { name: "Chat", arguments: "{}" } }]
  };
  const messages = await buildPromptMessagesWithToolResults(
    { ...defaultPromptProfile(), layers: layer(toolMessage) },
    promptContext(),
    async (_message, call) => ({ callId: call.id, ok: true, output: "result: ${{user}}" }),
    () => ({ name: "Chat", description: "chat", inputSchema: {}, passRenderText: true })
  );

  assert.equal(messages[1].content, "result: 小王");
});

test("promptMessages_multipleToolCalls_preserveArrayOrder", async () => {
  const toolMessage: PromptMessage = {
    ...message("Tool Request", "assistant", ""),
    toolCalls: [
      { id: "call_prompt_1", type: "function", function: { name: "Chat", arguments: "{\"action\":\"poll\"}" } },
      { id: "call_prompt_2", type: "function", function: { name: "Chat", arguments: "{\"query\":\"hi\"}" } }
    ]
  };
  const calls: string[] = [];
  const messages = await buildPromptMessagesWithToolResults(
    { ...defaultPromptProfile(), layers: layer(toolMessage) },
    promptContext(),
    async (_message, call) => {
      calls.push(call.id);
      return { callId: call.id, ok: true, output: call.toolName };
    }
  );

  assert.deepEqual(calls, ["call_prompt_1", "call_prompt_2"]);
  assert.deepEqual(messages.slice(1).map((entry) => entry.toolCallId), calls);
});

test("appendPromptMessages_executeAssistantToolCalls", async () => {
  const append: PromptMessage = {
    ...message("Append Tool Request", "assistant", ""),
    reasoningContent: "append thinking for ${{user}}",
    toolCalls: [{ id: "call_append_1", type: "function", function: { name: "Chat", arguments: "{\"action\":\"poll\"}" } }]
  };
  const messages = await buildAppendPromptMessagesWithToolResults(
    { ...defaultPromptProfile(), appendLayers: layer(append) },
    promptContext(),
    async (_message, call) => ({ callId: call.id, ok: true, output: "recent" })
  );

  assert.equal(messages[0].reasoningContent, "append thinking for 小王");
  assert.equal(messages[1].content, "recent");
});

test("promptMessages_useArrayOrderAndFilterDisabledMessages", () => {
  const profile = {
    ...defaultPromptProfile(),
    layers: layer(
      message("Second", "user", "second"),
      message("Disabled", "system", "disabled", false),
      message("First", "system", "first")
    )
  };
  assert.deepEqual(buildPromptMessages(profile, promptContext()).map((entry) => entry.content), ["second", "first"]);
});

test("promptPreview_assistantToolCall_includesToolResult", async () => {
  const context = promptContext();
  const profile = {
    ...defaultPromptProfile(),
    layers: layer({
      ...message("Tool Request", "assistant", ""),
      toolCalls: [{ id: "call_prompt_1", type: "function" as const, function: { name: "Chat", arguments: "{\"action\":\"poll\"}" } }]
    })
  };
  const runtime = createPromptToolPreviewRuntime({
    time: context.time,
    getPromptRenderer: () => context.renderer,
    toolPlugins: [{
      id: "messaging",
      listTools: () => [{ name: "Chat", description: "", inputSchema: {} }],
      execute: (call: any) => ({ callId: call.id, ok: true, output: "recent" })
    }],
    llmRequests: { buildTools: () => [] },
    messagingTools: { execute: () => undefined }
  });

  const messages = await runtime.buildPromptPreviewMessages(profile, textEvent());
  assert.equal(messages[0].toolCalls?.[0].function.name, "Chat");
  assert.equal(messages[1].content, "recent");
});

test("staticPromptFingerprint_ignoresAppendLayerChanges", () => {
  const context = promptContext();
  const base = {
    ...defaultPromptProfile(),
    layers: layer(message("Static", "system", "static")),
    appendLayers: layer(message("Append", "user", "append one"))
  };
  const changedAppend = { ...base, appendLayers: layer(message("Append", "user", "append two")) };
  const changedStatic = { ...base, layers: layer(message("Static", "system", "static changed")) };

  assert.equal(staticPromptFingerprint(base, context), staticPromptFingerprint(changedAppend, context));
  assert.notEqual(staticPromptFingerprint(base, context), staticPromptFingerprint(changedStatic, context));
});
