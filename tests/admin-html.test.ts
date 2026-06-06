import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAdminHtmlV2 } from "../apps/api/src/admin-html.js";

test("admin llm chain uses merged session view", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /LLM Sessions/);
  assert.match(html, /id="llmChainSessions"/);
  assert.doesNotMatch(html, /id="llmChainRequests"/);
  assert.doesNotMatch(html, /id="llmChainResponses"/);
});

test("llm session detail renders persisted jsonl shape", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /session\.jsonlEntries/);
  assert.match(html, /"\[meta\]"/);
  assert.match(html, /"\[message" \+ index \+ "\]"/);
  assert.doesNotMatch(html, /Session metadata/);
  assert.doesNotMatch(html, /Message transcript/);
});

test("llm api preset select applies directly without apply button", () => {
  const html = renderAdminHtmlV2();

  assert.doesNotMatch(html, /llm-preset-apply/);
  assert.doesNotMatch(html, /Apply Preset/);
  assert.doesNotMatch(html, /Current runtime config/);
  assert.match(html, /Choose API preset/);
  assert.match(html, /\$\("llmPresetSelect"\)\.addEventListener\("change", \(\) => \{[\s\S]*applyLLMApiPresetToForm\(preset\)/);
  assert.match(html, /currentLLMApiPreset = payload\.active/);
  assert.match(html, /if \(!currentLLMApiPreset\) clearLLMApiForm\(\)/);
  assert.match(html, /id="llm-preset-save">Save Preset<\/button>/);
  assert.match(html, /id="llm-preset-rename">Rename<\/button>/);
  assert.match(html, /id="llm-preset-delete" class="secondary">Delete<\/button>/);
});

test("llm api form saves only the full preset", () => {
  const html = renderAdminHtmlV2();
  const llmForm = html.match(/<form id="llm-form">[\s\S]*?<\/form>/)?.[0] ?? "";

  assert.match(html, /\$\("llm-form"\)\.addEventListener\("submit", async \(event\) => \{[\s\S]*await saveCurrentLLMApiPreset\(\)/);
  assert.doesNotMatch(html, /fetch\("\/admin\/api\/config\/llm"/);
  assert.doesNotMatch(llmForm, /<button type="submit">Save<\/button>/);
});

test("llm api preset save validates and refreshes from server", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /function validateLLMApiPresetForm\(\)/);
  assert.match(html, /Timeout Ms must be at least 1000/);
  assert.match(html, /label \+ " is not valid JSON\."/);
  assert.match(html, /\$\("save-status"\)\.textContent = "Saving preset\.\.\."/);
  assert.match(html, /if \(saved\) applyLLMApiPresetToForm\(saved\)/);
});

test("llm api preset form tracks dirty and saved states like shell editor", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /id="llmPresetMarker"/);
  assert.match(html, /function bindLLMApiPresetFormDirtyTracking\(\)/);
  assert.match(html, /markLLMApiPreset\("dirty"\)/);
  assert.match(html, /function persistLLMApiPreset\(name\)/);
  assert.match(html, /if \(!result\.ok\) throw new Error\(result\.error \|\| "unknown"\)/);
  assert.match(html, /markLLMApiPreset\("saved"\)/);
  assert.match(html, /bindLLMApiPresetFormDirtyTracking\(\)/);
});

test("plugin config test box is schema-driven for voice and ASR plugins", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /function renderPluginTestBox\(payload\)/);
  assert.match(html, /payload\.testSchema/);
  assert.match(html, /id="pluginTestText"/);
  assert.match(html, /id="pluginTestAudio"/);
  assert.match(html, /id="pluginConfigTest"/);
  assert.match(html, /Test translation and voice/);
  assert.match(html, /schema\.buttonLabel/);
  assert.match(html, /\/admin\/api\/plugins\/" \+ encodeURIComponent\(pluginId\) \+ "\/test"/);
  assert.match(html, /translationMs|ttsMs|totalMs|audio controls|Transcription/);
  assert.match(html, /field\.type === "number"/);
  assert.match(html, /input type="number" min="\$\{escapeAttr\(field\.min \?\? "0\.5"\)\}"/);
  assert.match(html, /input\.type === "number" && input\.value !== "" \? Number\(input\.value\)/);
});

test("plugin config fields can be split by schema-driven group selector", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /id="pluginConfigGroup"/);
  assert.match(html, /payload\.configSchema\.groups/);
  assert.match(html, /data-plugin-config-group=/);
  assert.match(html, /function applyPluginConfigGroupFilter/);
  assert.match(html, /pluginConfigGroup"\)\.addEventListener\("change", applyPluginConfigGroupFilter/);
});

test("chat prompt editor keeps variables in preview side pane", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /grid-template-areas: "mode preview" "api preview" "editor preview"/);
  assert.match(html, /function renderPromptSidePane\(mode, previewTitle, placeholder\)/);
  assert.match(html, /id="promptSideToggle"/);
  assert.match(html, /变量解析树/);
  assert.match(html, /renderPromptSidePane\(isTalk \? "talk" : "chat", isTalk \? "Talk Preview" : "Chat Preview"/);
  assert.match(html, /id="prompt-mode-talk"/);
  assert.match(html, /renderPromptSidePane\("memory", "Prompt Preview"/);
  assert.match(html, /return `<pre id="\$\{elementId\}">/);
  assert.match(html, /\.prompt-preview-pane > pre \{ max-height: calc\(100vh - 210px\); overflow: auto; \}/);
  assert.match(html, /\.logs pre \{ color: #17202a; \}/);
  assert.doesNotMatch(html, /<h2>Prompt Profile<\/h2>[\s\S]*<h2>Variables<\/h2>[\s\S]*<h2>Visible Tools<\/h2>/);
});

test("shell group add action is a reusable header plus button", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /class="shell-group-add" data-action="add-group"[^>]*>\+<\/button>/);
  assert.match(html, /content: "", group/);
  assert.match(html, /rerenderShellGroup\(category, group, true\)/);
  assert.match(html, /function rerenderShellGroup\(category, group, open\)/);
  assert.doesNotMatch(html, /shell-category-add/);
  assert.doesNotMatch(html, /insertAdjacentHTML\("beforeend", renderShellOption/);
  assert.doesNotMatch(html, /<div class="shell-category-body">[\s\S]*<\/div>\s*<button type="button" data-action="add">Add<\/button>/);
});

test("shell groups render as collapsed reusable details", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /<details class="shell-group" data-shell-group=/);
  assert.doesNotMatch(html, /<details class="shell-group" open>/);
});

test("memorize prompt editor does not show variables primer in edit pane", () => {
  const html = renderAdminHtmlV2();

  assert.doesNotMatch(html, /<h2>Memorize Layers<\/h2>/);
  assert.doesNotMatch(html, /<h2>Variables<\/h2>\s*<pre>\$\{escapeHtml\(\[/);
  assert.doesNotMatch(html, /\{\{memorize\/window\/startAt\}\}/);
});

test("chat and memorize previews share llm request block renderer", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /renderLLMRequestBlock\(mode === "talk" \? "Current Talk Prompt Profile Prebuild" : "Current Prompt Profile Prebuild", preview\)/);
  assert.match(html, /renderLLMRequestBlock\("Current Memorize Prompt Preview/);
  assert.match(html, /<div class="log-line">tools\\n/);
  assert.doesNotMatch(html, /<div class="log-line">metadata\\n/);
  assert.doesNotMatch(html, /tool: feishu\\n/);
});

test("token usage filter includes chat, talk, and memorize agents", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /<option value="chat">chat<\/option>/);
  assert.match(html, /<option value="talk">talk<\/option>/);
  assert.match(html, /<option value="memorize">memorize<\/option>/);
});

test("memory page shows selected day chat with undo and redo actions", () => {
  const html = renderAdminHtmlV2();

  assert.match(html, /id="memoryDayMessages"/);
  assert.match(html, /\/admin\/api\/memory\/messages\?date=/);
  assert.match(html, /id="memory-undo-last"/);
  assert.match(html, /\/admin\/api\/memory\/undo-last/);
  assert.match(html, /id="memory-redo-last"/);
  assert.match(html, /\/admin\/api\/memory\/redo-last/);
  assert.match(html, /id="memory-delete-latest-sql"/);
  assert.match(html, /\/admin\/api\/memory\/delete-latest-sql/);
  assert.match(html, /id="memory-clear-session"/);
  assert.match(html, /\/admin\/api\/memory\/clear-session/);
  assert.match(html, /data-memory-run=/);
  assert.match(html, /\/admin\/api\/memory\/run-target/);
  assert.match(html, /\/admin\/api\/memory\/run-progress/);
  assert.match(html, /renderMemoryCalendar/);
});
