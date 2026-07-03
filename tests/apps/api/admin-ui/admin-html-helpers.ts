import assert from "node:assert/strict";
import { renderAdminHtmlV2 } from "../../../../src/apps/api/admin-ui/admin-html.js";

export function renderAdminHtml(): string {
  return renderAdminHtmlV2();
}

export function assertIncludesAll(html: string, values: string[]): void {
  for (const value of values) {
    assert.ok(html.includes(value), `expected admin HTML to include ${value}`);
  }
}

export function assertExcludesAll(html: string, values: string[]): void {
  for (const value of values) {
    assert.ok(!html.includes(value), `expected admin HTML not to include ${value}`);
  }
}
