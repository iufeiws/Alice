import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSandboxNotesOutput } from "../../../src/contexts/bash-sandbox/src/index.js";

test("parseSandboxNotesOutput extracts name/description/path from frontmatter blocks", () => {
  const output = [
    "@@feishu-sending.md",
    "---",
    "name: feishu-sending",
    "description: 飞书消息发送必须用 chat send",
    "---",
    "",
    "# 正文（不属于 frontmatter）",
    "@@image-sending.md",
    "---",
    "name: image-sending",
    'description: 沙盒内发图用 type="file"',
    "---"
  ].join("\n");

  assert.deepEqual(parseSandboxNotesOutput(output, "/home/alice/.agents/notes"), [
    {
      name: "feishu-sending",
      description: "飞书消息发送必须用 chat send",
      path: "/home/alice/.agents/notes/feishu-sending.md"
    },
    {
      name: "image-sending",
      description: '沙盒内发图用 type="file"',
      path: "/home/alice/.agents/notes/image-sending.md"
    }
  ]);
});

test("parseSandboxNotesOutput falls back to file name when frontmatter is missing", () => {
  const output = "@@plain.md\n# 没有 frontmatter 的笔记\n";
  assert.deepEqual(parseSandboxNotesOutput(output, "/notes"), [
    { name: "plain", description: "", path: "/notes/plain.md" }
  ]);
});

test("parseSandboxNotesOutput returns empty list for empty output", () => {
  assert.deepEqual(parseSandboxNotesOutput("", "/notes"), []);
});
