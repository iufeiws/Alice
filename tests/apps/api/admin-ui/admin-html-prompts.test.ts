import { test } from "node:test";
import { assertExcludesAll, assertIncludesAll, renderAdminHtml } from "./admin-html-helpers.js";
import { renderPromptLayerScript } from "../../../../src/apps/api/admin-ui/shared/prompt-layer-script.js";
import { renderPromptsScript } from "../../../../src/apps/api/admin-ui/tabs/prompts-script.js";
import { renderInitiatedBehaviorsScript } from "../../../../src/apps/api/admin-ui/tabs/initiated-behaviors-script.js";

test("promptEditor_initialRender_exposesPromptWorkspace", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "Prompt Profile",
    "Talk Prompt Profile",
    "Visible Tools",
    "Chat",
    "Talk",
    "Memorize",
    "Chat API Preset",
    "Talk API Preset",
    "Message Delivery Reminder",
    "Add Reminder Message",
    "Save Prompt Profile",
    "变量解析树"
  ]);
});

test("promptEditor_birthdaySettings_exposesCalendarFields", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "Birthday",
    "Calendar",
    "Month",
    "Day",
    "Year",
    "Lunar leap month",
    "Save Birthday",
    "/admin/api/calendar/birthday"
  ]);
});

test("memorizePromptEditor_initialRender_exposesMemoryPromptControls", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "Memorize API Preset",
    "Save Memorize API Binding",
    "Save the Memorize prompt to refresh its preview.",
    "Current Memorize Prompt Preview"
  ]);
  assertExcludesAll(html, ["Memorize Error Layer", "memoryPrompts.errorLayer"]);
  assertExcludesAll(html, [
    "<h2>Memorize Layers</h2>",
    "${{memorize/window/startAt}}"
  ]);
});

test("promptPreview_clientContract_usesLlmRequestPreviewEndpoint", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "/admin/api/llm-requests",
    "Current Prompt Profile Prebuild",
    "Current Talk Prompt Profile Prebuild",
    "Loading preview..."
  ]);
});

test("layerEditor_usesUnifiedMessageProtocol", () => {
  const shared = renderPromptLayerScript();
  const consumers = renderPromptsScript() + renderInitiatedBehaviorsScript();

  assertIncludesAll(shared, [
    "renderLayerDocument",
    "bindLayerDocument",
    "message.meta.title",
    "reasoningContent",
    "toolCallId",
    "call?.function?.name"
  ]);
  assertExcludesAll(shared + consumers, [
    "renderPromptLayerDetails",
    "commonLayers",
    ".order",
    "toolArguments",
    "toolName: String",
    'role === "tool_request"'
  ]);
});

test("randomEventEditor_usesAssistantSelfRemindersWithoutNames", () => {
  const script = renderInitiatedBehaviorsScript();

  assertIncludesAll(script, [
    'roles: randomized ? ["assistant"]',
    "showName: !randomized",
    'role: randomized ? "assistant" : "user"'
  ]);
});
