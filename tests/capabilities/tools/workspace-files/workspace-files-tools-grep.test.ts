import { test } from "node:test";
import assert from "node:assert/strict";
import { fs, makeGitRepo, makeWorkspace, path } from "./workspace-files-tools-helpers.js";

test("Grep supports files_with_matches, content, count, glob filtering, no matches, and root limits", async () => {
  const { root, tools } = makeWorkspace("workspace-grep");
  makeGitRepo(root);
  fs.writeFileSync(path.join(root, "a.txt"), "needle\nother\nneedle\n");
  fs.writeFileSync(path.join(root, "b.md"), "needle in markdown\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "needle ignored\n");
  fs.writeFileSync(path.join(root, "multi.txt"), "start\nmiddle\nend\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");

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
