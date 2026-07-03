import { test } from "node:test";
import { assertIncludesAll, renderAdminHtml } from "./admin-html-helpers.js";

test("memoryPage_initialRender_exposesDayRunControls", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "<h2>Memory</h2>",
    "Run Selected Day",
    "Clear Session",
    "Undo Last Run",
    "Redo Last Run",
    "Delete Latest SQL",
    "Selected Day Chat",
    "Choose a date to load chat records.",
    "Last Run"
  ]);
});

test("memoryPage_clientContract_usesMemoryEndpoints", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "/admin/api/memory",
    "/admin/api/memory/messages?date=",
    "/admin/api/memory/run-day",
    "/admin/api/memory/run-target",
    "/admin/api/memory/run-progress?id=",
    "/admin/api/memory/undo-last",
    "/admin/api/memory/redo-last",
    "/admin/api/memory/delete-latest-sql",
    "/admin/api/memory/clear-session"
  ]);
});

test("shellEditor_initialRender_exposesShellWorkspace", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "Daily Shell",
    "Reroll Today",
    "Shell Settings",
    "Daily Refresh Clock (0-23)",
    "Save Shell Settings",
    "语气 / 称呼",
    "服装",
    "拖入或粘贴图片自动上传"
  ]);
});

test("shellEditor_clientContract_usesShellEndpoints", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "/admin/api/shell",
    "/admin/api/shell-ui/order",
    "/admin/api/shell-option",
    "/admin/api/shell/reroll",
    "/admin/api/shell-settings",
    "/admin/api/shell/outfit-image"
  ]);
});
