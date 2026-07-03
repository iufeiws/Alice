import { test } from "node:test";
import assert from "node:assert/strict";
import { fs, makeWorkspace, path } from "./workspace-files-tools-helpers.js";

test("Read returns cat-n style line numbers and supports paging", async () => {
  const { root, tools } = makeWorkspace("workspace-read");
  fs.writeFileSync(path.join(root, "notes.txt"), "one\ntwo\nthree\n");

  const first = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "notes.txt", offset: 2, limit: 1 } });

  assert.equal(first.ok, true);
  assert.equal(first.output, "     2\ttwo\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]");
});

test("Read reports empty files and rejects paths outside workspace", async () => {
  const { root, tools } = makeWorkspace("workspace-read-empty");
  const outsidePath = path.join(makeWorkspace("workspace-outside").root, "secret.txt");
  fs.writeFileSync(path.join(root, "empty.txt"), "");
  fs.writeFileSync(outsidePath, "secret");

  const empty = await tools.execute({ id: "read_empty", toolName: "Read", input: { file_path: "empty.txt" } });
  const outside = await tools.execute({ id: "read_outside", toolName: "Read", input: { file_path: outsidePath } });
  const escape = await tools.execute({ id: "read_escape", toolName: "Read", input: { file_path: "./secret.txt" } });

  assert.equal(empty.ok, true);
  assert.equal(empty.output, "File is empty.");
  assert.equal(outside.ok, false);
  assert.match(outside.error ?? "", /workspace-relative/);
  assert.equal(escape.ok, false);
  assert.match(escape.error ?? "", /outside the workspace/);
});
