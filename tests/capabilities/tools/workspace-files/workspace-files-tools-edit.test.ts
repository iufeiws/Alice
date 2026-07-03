import { test } from "node:test";
import assert from "node:assert/strict";
import { fs, makeWorkspace, path } from "./workspace-files-tools-helpers.js";

test("Edit requires a prior Read and rejects files changed after read", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-read-first");
  fs.writeFileSync(path.join(root, "notes.txt"), "old\n");

  const unread = await tools.execute({
    id: "edit_unread",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "old", new_string: "new" }
  });
  await tools.execute({ id: "read", toolName: "Read", input: { file_path: "notes.txt" } });
  fs.writeFileSync(path.join(root, "notes.txt"), "external\n");
  const changed = await tools.execute({
    id: "edit_changed",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "external", new_string: "new" }
  });

  assert.equal(unread.ok, false);
  assert.match(unread.error ?? "", /read with Read/i);
  assert.equal(changed.ok, false);
  assert.match(changed.error ?? "", /changed since/i);
});

test("Edit performs exact replacement and replace_all handles repeated matches", async () => {
  const { root, tools } = makeWorkspace("workspace-edit");
  const filePath = path.join(root, "notes.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\nalpha\n");

  await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "notes.txt" } });
  const ambiguous = await tools.execute({
    id: "edit_ambiguous",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "alpha", new_string: "omega" }
  });
  const replaceAll = await tools.execute({
    id: "edit_all",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "alpha", new_string: "omega", replace_all: true }
  });
  const unique = await tools.execute({
    id: "edit_unique",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "beta", new_string: "delta" }
  });

  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /appears 2 times/);
  assert.match(ambiguous.error ?? "", /surrounding context/);
  assert.equal(replaceAll.ok, true);
  assert.equal(replaceAll.output, "The file notes.txt has been updated.");
  assert.equal(unique.ok, true);
  assert.equal(fs.readFileSync(filePath, "utf8"), "omega\ndelta\nomega\n");
});

test("Edit reports safe diagnostics for near misses without changing the file", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-diagnostics");
  fs.writeFileSync(path.join(root, "crlf.txt"), "alpha\r\nbeta\r\n");
  fs.writeFileSync(path.join(root, "whitespace.txt"), "alpha  \n  beta\n");
  fs.writeFileSync(path.join(root, "unicode.txt"), "caf\u00e9\n");

  await tools.execute({ id: "read_crlf", toolName: "Read", input: { file_path: "crlf.txt" } });
  const crlfMiss = await tools.execute({ id: "edit_crlf", toolName: "Edit", input: { file_path: "crlf.txt", old_string: "alpha\nbeta\n", new_string: "changed\n" } });
  await tools.execute({ id: "read_whitespace", toolName: "Read", input: { file_path: "whitespace.txt" } });
  const whitespaceMiss = await tools.execute({ id: "edit_whitespace", toolName: "Edit", input: { file_path: "whitespace.txt", old_string: "alpha\nbeta\n", new_string: "changed\n" } });
  await tools.execute({ id: "read_unicode", toolName: "Read", input: { file_path: "unicode.txt" } });
  const unicodeMiss = await tools.execute({ id: "edit_unicode", toolName: "Edit", input: { file_path: "unicode.txt", old_string: "cafe\u0301\n", new_string: "changed\n" } });

  assert.equal(crlfMiss.ok, false);
  assert.match(crlfMiss.error ?? "", /line ending mismatch/);
  assert.equal(fs.readFileSync(path.join(root, "crlf.txt"), "utf8"), "alpha\r\nbeta\r\n");
  assert.equal(whitespaceMiss.ok, false);
  assert.match(whitespaceMiss.error ?? "", /whitespace/);
  assert.match(whitespaceMiss.error ?? "", /whitespace-normalized match/);
  assert.equal(fs.readFileSync(path.join(root, "whitespace.txt"), "utf8"), "alpha  \n  beta\n");
  assert.equal(unicodeMiss.ok, false);
  assert.match(unicodeMiss.error ?? "", /Unicode normalization mismatch/);
  assert.equal(fs.readFileSync(path.join(root, "unicode.txt"), "utf8"), "caf\u00e9\n");
});
