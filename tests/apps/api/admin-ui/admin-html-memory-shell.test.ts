import { test } from "node:test";
import assert from "node:assert/strict";
import { assertExcludesAll, assertIncludesAll, renderAdminHtml } from "./admin-html-helpers.js";

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
    "语气 / 称呼",
    "服装",
    "拖入或粘贴图片自动上传"
  ]);
});

test("shellEditor_imagePasteTarget_supportsMobilePaste", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    'drop.contentEditable = "true"',
    'drop.setAttribute("inputmode", "none")',
    'drop.addEventListener("beforeinput"'
  ]);
});

test("shellEditor_clientContract_usesShellEndpoints", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "/admin/api/shell",
    "/admin/api/shell-ui/order",
    "/admin/api/shell-option",
    "/admin/api/shell/reroll",
    "/admin/api/shell/outfit-image"
  ]);
});

// --- Short Memory 区块（计划 §8.3 / §12.7）---

test("memoryPage_shortMemorySection_isReadOnlyWithoutControls", () => {
  const html = renderAdminHtml();

  const start = html.indexOf("<h2>Short Memory</h2>");
  assert.ok(start >= 0, "expected a Short Memory section heading in the admin HTML");

  // 区块边界：到下一个 <h2> 或所在 pane 的 </section> 为止。
  const nextHeading = html.indexOf("<h2>", start + 1);
  const paneEnd = html.indexOf("</section>", start);
  const candidates = [nextHeading, paneEnd].filter((index) => index > start);
  const end = Math.min(...candidates);
  const block = html.slice(start, end);

  assert.ok(block.length > 0, "expected non-empty Short Memory section");
  // 只读区块：不提供保存、删除或编辑控件。
  for (const control of ["<button", "<textarea", "<input", "contenteditable"]) {
    assert.ok(!block.includes(control), `expected no ${control} in the Short Memory section`);
  }
});

test("memoryPage_shortMemoryScript_escapesContentAndShowsLocalTime", () => {
  const html = renderAdminHtml();

  // 区块数据来自 GET /admin/api/memory 响应的 shortMemories；内容与本地时间 createdAt 必须经 escapeHtml 输出。
  assertIncludesAll(html, [
    "shortMemories",
    "escapeHtml(entry.content",
    "escapeHtml(entry.createdAt"
  ]);
});

test("memoryPage_shortMemoryScript_rendersNewestFirstWithoutResorting", () => {
  const html = renderAdminHtml();

  // API 已按 createdAtUtc DESC 返回，页面按数组顺序展示最新优先，不得二次反转或重排。
  assertIncludesAll(html, ["shortMemories.map"]);
  assertExcludesAll(html, ["shortMemories.reverse()", "shortMemories.sort("]);
});
