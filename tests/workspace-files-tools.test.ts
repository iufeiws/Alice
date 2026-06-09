import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceFilesTools } from "../src/capabilities/tools/workspace-files/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("Read returns cat-n style line numbers and supports paging", async () => {
  const root = makeTempDir("workspace-read");
  fs.writeFileSync(path.join(root, "notes.txt"), "one\ntwo\nthree\n");
  const tools = createWorkspaceFilesTools({ root });

  const first = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "notes.txt", offset: 2, limit: 1 } });

  assert.equal(first.ok, true);
  assert.equal(first.output, "     2\ttwo\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]");
});

test("Read reports empty files and rejects paths outside workspace", async () => {
  const root = makeTempDir("workspace-read-empty");
  const outsidePath = path.join(makeTempDir("workspace-outside"), "secret.txt");
  fs.writeFileSync(path.join(root, "empty.txt"), "");
  fs.writeFileSync(outsidePath, "secret");
  const tools = createWorkspaceFilesTools({ root });

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

test("Edit requires a prior Read and rejects files changed after read", async () => {
  const root = makeTempDir("workspace-edit-read-first");
  fs.writeFileSync(path.join(root, "notes.txt"), "old\n");
  const tools = createWorkspaceFilesTools({ root });

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
  const root = makeTempDir("workspace-edit");
  const filePath = path.join(root, "notes.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\nalpha\n");
  const tools = createWorkspaceFilesTools({ root });

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
  const root = makeTempDir("workspace-edit-diagnostics");
  fs.writeFileSync(path.join(root, "crlf.txt"), "alpha\r\nbeta\r\n");
  fs.writeFileSync(path.join(root, "whitespace.txt"), "alpha  \n  beta\n");
  fs.writeFileSync(path.join(root, "unicode.txt"), "caf\u00e9\n");
  const tools = createWorkspaceFilesTools({ root });

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

test("Glob supports recursive matches, mtime sorting, truncation, and root limits", async () => {
  const root = makeTempDir("workspace-glob");
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, "old.txt"), "old");
  await sleep(20);
  fs.writeFileSync(path.join(nested, "new.txt"), "new");
  fs.writeFileSync(path.join(root, "config.json"), "{}");
  fs.writeFileSync(path.join(root, "config.yaml"), "name: x");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "ignored");
  for (let index = 0; index < 101; index += 1) fs.writeFileSync(path.join(root, `many-${index}.md`), "x");
  const tools = createWorkspaceFilesTools({ root });

  const txt = await tools.execute({ id: "glob_txt", toolName: "Glob", input: { pattern: "**/*.txt" } });
  const brace = await tools.execute({ id: "glob_brace", toolName: "Glob", input: { pattern: "*.{json,yaml}" } });
  const many = await tools.execute({ id: "glob_many", toolName: "Glob", input: { pattern: "**/*.md" } });
  const outside = await tools.execute({ id: "glob_outside", toolName: "Glob", input: { pattern: "**/*", path: ".." } });

  assert.equal(txt.ok, true);
  const txtLines = String(txt.output).split(/\r?\n/);
  assert.ok(txtLines.indexOf("nested/new.txt") < txtLines.indexOf("old.txt"));
  assert.match(String(txt.output), /ignored\.txt/);
  assert.match(String(brace.output), /config\.json/);
  assert.match(String(brace.output), /config\.yaml/);
  assert.doesNotMatch(String(txt.output), /[A-Z]:\\/i);
  assert.equal(many.ok, true);
  assert.match(String(many.output), /Results truncated to 100 of 101 matches/);
  assert.equal(outside.ok, false);
  assert.match(outside.error ?? "", /outside the workspace/);
});

test("Grep supports files_with_matches, content, count, glob filtering, no matches, and root limits", async () => {
  const root = makeTempDir("workspace-grep");
  makeGitRepo(root);
  fs.writeFileSync(path.join(root, "a.txt"), "needle\nother\nneedle\n");
  fs.writeFileSync(path.join(root, "b.md"), "needle in markdown\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "needle ignored\n");
  fs.writeFileSync(path.join(root, "multi.txt"), "start\nmiddle\nend\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  const tools = createWorkspaceFilesTools({ root });

  const files = await tools.execute({ id: "grep_files", toolName: "Grep", input: { pattern: "needle", path: "." } });
  const content = await tools.execute({ id: "grep_content", toolName: "Grep", input: { pattern: "needle", path: ".", glob: "*.txt", output_mode: "content" } });
  const count = await tools.execute({ id: "grep_count", toolName: "Grep", input: { pattern: "needle", path: ".", output_mode: "count" } });
  const typed = await tools.execute({ id: "grep_type", toolName: "Grep", input: { pattern: "needle", path: ".", type: "md" } });
  const ignoredDirect = await tools.execute({ id: "grep_ignored_direct", toolName: "Grep", input: { pattern: "needle", path: "ignored.txt" } });
  const multiline = await tools.execute({ id: "grep_multiline", toolName: "Grep", input: { pattern: "start.*end", path: "multi.txt", output_mode: "content", multiline: true } });
  const none = await tools.execute({ id: "grep_none", toolName: "Grep", input: { pattern: "missing", path: "." } });
  const outside = await tools.execute({ id: "grep_outside", toolName: "Grep", input: { pattern: "needle", path: ".." } });

  assert.equal(files.ok, true);
  assert.match(String(files.output), /a\.txt/);
  assert.match(String(files.output), /b\.md/);
  assert.doesNotMatch(String(files.output), /ignored\.txt/);
  assert.equal(content.ok, true);
  assert.match(String(content.output), /a\.txt:1:needle/);
  assert.doesNotMatch(String(content.output), /b\.md/);
  assert.doesNotMatch(String(content.output), /ignored\.txt/);
  assert.equal(count.ok, true);
  assert.match(String(count.output), /a\.txt:2/);
  assert.match(String(count.output), /b\.md:1/);
  assert.equal(typed.ok, true);
  assert.doesNotMatch(String(typed.output), /a\.txt/);
  assert.match(String(typed.output), /b\.md/);
  assert.equal(ignoredDirect.ok, true);
  assert.match(String(ignoredDirect.output), /ignored\.txt/);
  assert.equal(multiline.ok, true);
  assert.match(String(multiline.output), /1:start/);
  assert.match(String(multiline.output), /3:end/);
  assert.equal(none.ok, true);
  assert.equal(none.output, "No matches found");
  assert.equal(outside.ok, false);
  assert.match(outside.error ?? "", /outside the workspace/);
});

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeGitRepo(root: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
}
