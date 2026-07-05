import { test } from "node:test";
import assert from "node:assert/strict";
import { fs, makeGitRepo, makeWorkspace, path } from "./workspace-files-tools-helpers.js";

function makeGrepWorkspace(name: string) {
  const { root, tools } = makeWorkspace(name);
  makeGitRepo(root);
  fs.writeFileSync(path.join(root, "a.txt"), "needle\nother\nneedle\n");
  fs.writeFileSync(path.join(root, "b.md"), "needle in markdown\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "needle ignored\n");
  fs.writeFileSync(path.join(root, "multi.txt"), "start\nmiddle\nend\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  return { tools };
}

test("Grep files_with_matches respects gitignore", async () => {
  const { tools } = makeGrepWorkspace("workspace-grep-files");

  const files = await tools.execute({ id: "grep_files", toolName: "Grep", input: { pattern: "needle", path: "." } });

  assert.equal(files.ok, true);
  assert.match(String(files.output), /a\.txt/);
  assert.match(String(files.output), /b\.md/);
  assert.doesNotMatch(String(files.output), /ignored\.txt/);
});

test("Grep content output respects glob filters", async () => {
  const { tools } = makeGrepWorkspace("workspace-grep-content");

  const content = await tools.execute({ id: "grep_content", toolName: "Grep", input: { pattern: "needle", path: ".", glob: "*.txt", output_mode: "content" } });

  assert.equal(content.ok, true);
  assert.match(String(content.output), /a\.txt:1:needle/);
  assert.doesNotMatch(String(content.output), /b\.md/);
  assert.doesNotMatch(String(content.output), /ignored\.txt/);
});

test("Grep count output returns match counts", async () => {
  const { tools } = makeGrepWorkspace("workspace-grep-count");

  const count = await tools.execute({ id: "grep_count", toolName: "Grep", input: { pattern: "needle", path: ".", output_mode: "count" } });

  assert.equal(count.ok, true);
  assert.match(String(count.output), /a\.txt:2/);
  assert.match(String(count.output), /b\.md:1/);
});

test("Grep type filter limits searched files", async () => {
  const { tools } = makeGrepWorkspace("workspace-grep-type");

  const typed = await tools.execute({ id: "grep_type", toolName: "Grep", input: { pattern: "needle", path: ".", type: "md" } });

  assert.equal(typed.ok, true);
  assert.doesNotMatch(String(typed.output), /a\.txt/);
  assert.match(String(typed.output), /b\.md/);
});

test("Grep can search an ignored file when addressed directly", async () => {
  const { tools } = makeGrepWorkspace("workspace-grep-ignored-direct");

  const ignoredDirect = await tools.execute({ id: "grep_ignored_direct", toolName: "Grep", input: { pattern: "needle", path: "ignored.txt" } });

  assert.equal(ignoredDirect.ok, true);
  assert.match(String(ignoredDirect.output), /ignored\.txt/);
});

test("Grep multiline searches across line breaks", async () => {
  const { tools } = makeGrepWorkspace("workspace-grep-multiline");

  const multiline = await tools.execute({ id: "grep_multiline", toolName: "Grep", input: { pattern: "start.*end", path: "multi.txt", output_mode: "content", multiline: true } });

  assert.equal(multiline.ok, true);
  assert.match(String(multiline.output), /1:start/);
  assert.match(String(multiline.output), /3:end/);
});

test("Grep reports no matches", async () => {
  const { tools } = makeGrepWorkspace("workspace-grep-none");

  const none = await tools.execute({ id: "grep_none", toolName: "Grep", input: { pattern: "missing", path: "." } });

  assert.equal(none.ok, true);
  assert.equal(none.output, "No matches found");
});

test("Grep rejects roots outside workspace", async () => {
  const { tools } = makeGrepWorkspace("workspace-grep-outside");

  const outside = await tools.execute({ id: "grep_outside", toolName: "Grep", input: { pattern: "needle", path: ".." } });

  assert.equal(outside.ok, false);
  assert.match(outside.error ?? "", /outside the workspace/);
});
