import { test } from "node:test";
import assert from "node:assert/strict";
import { fs, makeWorkspace, path } from "./workspace-files-tools-helpers.js";

test("Edit requires a prior Read", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-read-first");
  fs.writeFileSync(path.join(root, "notes.txt"), "old\n");

  const unread = await tools.execute({
    id: "edit_unread",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "old", new_string: "new" }
  });

  assert.equal(unread.ok, false);
  assert.match(unread.error ?? "", /read with Read/i);
});

test("Edit rejects files changed after Read", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-changed");
  fs.writeFileSync(path.join(root, "notes.txt"), "old\n");

  await tools.execute({ id: "read", toolName: "Read", input: { file_path: "notes.txt" } });
  fs.writeFileSync(path.join(root, "notes.txt"), "external\n");
  const changed = await tools.execute({
    id: "edit_changed",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "external", new_string: "new" }
  });

  assert.equal(changed.ok, false);
  assert.match(changed.error ?? "", /changed since/i);
});

test("Edit performs exact replacement", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-unique");
  const filePath = path.join(root, "notes.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\n");

  await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "notes.txt" } });
  const result = await tools.execute({
    id: "edit_unique",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "beta", new_string: "delta" }
  });

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(filePath, "utf8"), "alpha\ndelta\n");
});

test("Edit rejects repeated matches without replace_all", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-ambiguous");
  const filePath = path.join(root, "notes.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\nalpha\n");

  await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "notes.txt" } });
  const ambiguous = await tools.execute({
    id: "edit_ambiguous",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "alpha", new_string: "omega" }
  });

  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /appears 2 times/);
});

test("Edit replace_all handles repeated matches", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-replace-all");
  const filePath = path.join(root, "notes.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\nalpha\n");

  await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "notes.txt" } });
  const replaceAll = await tools.execute({
    id: "edit_all",
    toolName: "Edit",
    input: { file_path: "notes.txt", old_string: "alpha", new_string: "omega", replace_all: true }
  });

  assert.equal(replaceAll.ok, true);
  assert.equal(fs.readFileSync(filePath, "utf8"), "omega\nbeta\nomega\n");
});

test("Edit reports line ending mismatches", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-crlf");
  fs.writeFileSync(path.join(root, "crlf.txt"), "alpha\r\nbeta\r\n");

  await tools.execute({ id: "read_crlf", toolName: "Read", input: { file_path: "crlf.txt" } });
  const crlfMiss = await tools.execute({ id: "edit_crlf", toolName: "Edit", input: { file_path: "crlf.txt", old_string: "alpha\nbeta\n", new_string: "changed\n" } });

  assert.equal(crlfMiss.ok, false);
  assert.match(crlfMiss.error ?? "", /line ending mismatch/);
});

test("Edit reports whitespace near misses", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-whitespace");
  fs.writeFileSync(path.join(root, "whitespace.txt"), "alpha  \n  beta\n");

  await tools.execute({ id: "read_whitespace", toolName: "Read", input: { file_path: "whitespace.txt" } });
  const whitespaceMiss = await tools.execute({ id: "edit_whitespace", toolName: "Edit", input: { file_path: "whitespace.txt", old_string: "alpha\nbeta\n", new_string: "changed\n" } });

  assert.equal(whitespaceMiss.ok, false);
  assert.match(whitespaceMiss.error ?? "", /whitespace/);
});

test("Edit reports Unicode normalization mismatches", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-unicode");
  fs.writeFileSync(path.join(root, "unicode.txt"), "caf\u00e9\n");

  await tools.execute({ id: "read_unicode", toolName: "Read", input: { file_path: "unicode.txt" } });
  const unicodeMiss = await tools.execute({ id: "edit_unicode", toolName: "Edit", input: { file_path: "unicode.txt", old_string: "cafe\u0301\n", new_string: "changed\n" } });

  assert.equal(unicodeMiss.ok, false);
  assert.match(unicodeMiss.error ?? "", /Unicode normalization mismatch/);
});

test("Edit leaves the file unchanged when replacement fails", async () => {
  const { root, tools } = makeWorkspace("workspace-edit-unchanged");
  const filePath = path.join(root, "notes.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\n");

  await tools.execute({ id: "read_unchanged", toolName: "Read", input: { file_path: "notes.txt" } });
  const unchanged = await tools.execute({ id: "edit_unchanged", toolName: "Edit", input: { file_path: "notes.txt", old_string: "missing", new_string: "changed" } });

  assert.equal(unchanged.ok, false);
  assert.equal(fs.readFileSync(filePath, "utf8"), "alpha\nbeta\n");
});
