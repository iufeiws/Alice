import { test } from "node:test";
import assert from "node:assert/strict";
import { fs, makeWorkspace, path } from "./workspace-files-tools-helpers.js";

test("Glob supports recursive matches, mtime sorting, truncation, and root limits", async () => {
  const { root, tools } = makeWorkspace("workspace-glob");
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested, { recursive: true });
  const oldFile = path.join(root, "old.txt");
  const newFile = path.join(nested, "new.txt");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(newFile, "new");
  fs.utimesSync(oldFile, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
  fs.utimesSync(newFile, new Date("2026-01-01T00:00:01.000Z"), new Date("2026-01-01T00:00:01.000Z"));
  fs.writeFileSync(path.join(root, "config.json"), "{}");
  fs.writeFileSync(path.join(root, "config.yaml"), "name: x");
  for (let index = 0; index < 101; index += 1) fs.writeFileSync(path.join(root, `many-${index}.md`), "x");

  const txt = await tools.execute({ id: "glob_txt", toolName: "Glob", input: { pattern: "**/*.txt" } });
  const brace = await tools.execute({ id: "glob_brace", toolName: "Glob", input: { pattern: "*.{json,yaml}" } });
  const many = await tools.execute({ id: "glob_many", toolName: "Glob", input: { pattern: "**/*.md" } });
  const outside = await tools.execute({ id: "glob_outside", toolName: "Glob", input: { pattern: "**/*", path: ".." } });

  assert.equal(txt.ok, true);
  const txtLines = String(txt.output).split(/\r?\n/);
  assert.ok(txtLines.indexOf("nested/new.txt") < txtLines.indexOf("old.txt"));
  assert.match(String(brace.output), /config\.json/);
  assert.match(String(brace.output), /config\.yaml/);
  assert.doesNotMatch(String(txt.output), /[A-Z]:\\/i);
  assert.equal(many.ok, true);
  assert.match(String(many.output), /Results truncated to 100 of 101 matches/);
  assert.equal(outside.ok, false);
  assert.match(outside.error ?? "", /outside the workspace/);
});
