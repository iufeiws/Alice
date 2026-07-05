import { test } from "node:test";
import assert from "node:assert/strict";
import { fs, makeWorkspace, path } from "./workspace-files-tools-helpers.js";

test("Read returns cat-n style line numbers", async () => {
  const { root, tools } = makeWorkspace("workspace-read-line-numbers");
  fs.writeFileSync(path.join(root, "notes.txt"), "one\ntwo\n");

  const first = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "notes.txt" } });

  assert.equal(first.ok, true);
  assert.equal(first.output, "     1\tone\n     2\ttwo");
});

test("Read returns paging continuation", async () => {
  const { root, tools } = makeWorkspace("workspace-read");
  fs.writeFileSync(path.join(root, "notes.txt"), "one\ntwo\nthree\n");

  const first = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "notes.txt", offset: 2, limit: 1 } });

  assert.equal(first.ok, true);
  assert.match(String(first.output), /\[Showing lines 2-2 of 3\. Use offset=3 to continue\.\]$/);
});

test("Read reports empty files", async () => {
  const { root, tools } = makeWorkspace("workspace-read-empty");
  fs.writeFileSync(path.join(root, "empty.txt"), "");

  const empty = await tools.execute({ id: "read_empty", toolName: "Read", input: { file_path: "empty.txt" } });

  assert.equal(empty.ok, true);
  assert.equal(empty.output, "File is empty.");
});

test("Read rejects absolute paths outside workspace", async () => {
  const { tools } = makeWorkspace("workspace-read-absolute");
  const outsidePath = path.join(makeWorkspace("workspace-outside").root, "secret.txt");
  fs.writeFileSync(outsidePath, "secret");

  const outside = await tools.execute({ id: "read_outside", toolName: "Read", input: { file_path: outsidePath } });

  assert.equal(outside.ok, false);
  assert.match(outside.error ?? "", /workspace-relative/);
});

test("Read rejects traversal outside workspace", async () => {
  const { tools } = makeWorkspace("workspace-read-traversal");

  const escape = await tools.execute({ id: "read_escape", toolName: "Read", input: { file_path: "./secret.txt" } });

  assert.equal(escape.ok, false);
  assert.match(escape.error ?? "", /outside the workspace/);
});
