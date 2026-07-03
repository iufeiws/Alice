import { test } from "node:test";
import { assertExcludesAll, assertIncludesAll, renderAdminHtml } from "./admin-html-helpers.js";

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
    "Save a Memorize group to refresh its preview.",
    "Current Memorize Prompt Preview"
  ]);
  assertExcludesAll(html, [
    "<h2>Memorize Layers</h2>",
    "{{memorize/window/startAt}}"
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
