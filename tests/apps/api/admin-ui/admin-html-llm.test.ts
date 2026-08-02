import { test } from "node:test";
import { assertExcludesAll, assertIncludesAll, renderAdminHtml } from "./admin-html-helpers.js";

test("llmSessions_initialRender_exposesSessionControls", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "LLM Sessions",
    "Cancel Current Run",
    "Clear Active Session",
    "<h2>Sessions</h2>",
    "No LLM session yet."
  ]);
});

test("llmApiPreset_initialRender_exposesPresetEditor", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "<h2>LLM API</h2>",
    "API Preset",
    "Preset Name",
    "Save Preset",
    "Rename",
    "Delete",
    "Base URL",
    "Model",
    "API Key",
    "Max Tokens (optional)",
    "Timeout Ms",
    "Extra Params JSON",
    "Follow-up Extra Params JSON"
  ]);
  assertExcludesAll(html, ["Apply Preset", "Current runtime config"]);
});

test("llmApiPreset_clientContract_usesPresetEndpointsAndStatuses", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "/admin/api/config/llm-presets",
    "/admin/api/config/llm-presets/rename",
    "Choose API preset",
    "Saving preset...",
    "Max Tokens must be a positive integer.",
    "Timeout Ms must be at least 1000",
    " is not valid JSON."
  ]);
});

test("tokenUsage_initialRender_exposesAgentFilters", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "Range",
    "Bucket",
    "Model",
    "Agent",
    "<option value=\"chat\">chat</option>",
    "<option value=\"talk\">talk</option>",
    "<option value=\"memorize\">memorize</option>",
    "<option value=\"tts\">tts</option>"
  ]);
});
