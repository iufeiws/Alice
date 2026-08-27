import { test } from "node:test";
import assert from "node:assert/strict";
import { readSandboxNotesIndex } from "../../../src/contexts/bash-sandbox/src/index.js";
import { testConfig, tmpDir } from "./bash-sandbox-helpers.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("notes index scans the host directory mapped from the container notes path", () => {
  const root = tmpDir("container-notes");
  const hostAgentDir = path.join(root, "agent");
  const config = testConfig({
    hostWorkspaceDir: path.join(root, "workspace"),
    mounts: [{ id: "agent", hostPath: hostAgentDir, containerPath: "/home/alice/.agents", readOnly: false }]
  });
  const notesDir = path.join(hostAgentDir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "feishu-sending.md"), [
    "---",
    "name: feishu-sending",
    "description: 飞书消息发送必须用 chat send",
    "---",
    "# 正文（不属于 frontmatter）"
  ].join("\n"));
  fs.writeFileSync(path.join(notesDir, "image-sending.md"), [
    "---",
    "name: image-sending",
    'description: 沙盒内发图用 type="file"',
    "---"
  ].join("\n"));

  assert.deepEqual(readSandboxNotesIndex(config, config.notesDir), [
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

test("notes index falls back to file name and treats a missing mapped directory as empty", () => {
  const config = testConfig();
  const notesDir = path.join(config.hostWorkspaceDir, ".agents", "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "plain.md"), "# 没有 frontmatter 的笔记\n");

  assert.deepEqual(readSandboxNotesIndex(config, config.notesDir), [
    { name: "plain", description: "", path: "/home/alice/.agents/notes/plain.md" }
  ]);
  assert.deepEqual(readSandboxNotesIndex(config, "/home/alice/missing-notes"), []);
});

test("notes index rejects a container path outside every host mount", () => {
  assert.throws(
    () => readSandboxNotesIndex(testConfig(), "/unmounted/notes"),
    /sandbox notes directory is not mounted/
  );
});
