import { test } from "node:test";
import assert from "node:assert/strict";
import { createFileTools as createFileToolsRuntime } from "../../../../src/capabilities/tools/file/src/index.js";
import { testPromptRuntime } from "../../../helpers/prompt-runtime.js";
import type { BashSandboxRuntime } from "../../../../src/contexts/bash-sandbox/src/index.js";
import { testConfig } from "../../../contexts/bash-sandbox/bash-sandbox-helpers.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

function createFileTools(input: Omit<Parameters<typeof createFileToolsRuntime>[0], "promptContextRuntime">) {
  return createFileToolsRuntime({ ...input, promptContextRuntime: testPromptRuntime() });
}

// @ts-expect-error file tool wrappers are runtime .mjs entry modules.
const { runReadTool } = await import("../../../../src/contexts/bash-sandbox/wrappers/file-tool-core.mjs");

test("file tools exposes Read Edit Glob and Grep", () => {
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async () => readOutput("/workspace/notes.txt", "one", 1, 1))
  });

  assert.equal(tools.id, "file-tools");
  assert.deepEqual(tools.listTools().map((tool) => tool.name), ["Read", "Edit", "Glob", "Grep"]);
});

test("Read runs against an absolute sandbox path", async () => {
  const calls: Record<string, unknown>[] = [];
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async (payload) => {
      calls.push(payload);
      return readOutput(String(payload.file_path), "one\ntwo", 2, 123);
    })
  });

  const result = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "/workspace/notes.txt", offset: 1, limit: 2 } });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file_path, "/workspace/notes.txt");
});

test("Read does not count an empty file as one line", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-empty-read-"));
  const filePath = path.join(root, "empty.txt");
  fs.writeFileSync(filePath, "");

  const output = await runReadTool({ file_path: filePath, allowed_roots: [root], cwd: root });

  assert.equal(output.file.content, "");
  assert.equal(output.file.numLines, 0);
  assert.equal(output.file.totalLines, 0);
});

test("Read reports empty files as empty instead of shorter than offset", async () => {
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async () => readOutput("/workspace/empty.txt", "", 0, 123))
  });

  const result = await tools.execute({ id: "read_empty", toolName: "Read", input: { file_path: "/workspace/empty.txt" } });

  assert.equal(result.ok, true);
});

test("Read asks sandbox for base64 when reading supported image files", async () => {
  const cwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-image-config-"));
  const calls: Record<string, unknown>[] = [];
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async (payload) => {
      calls.push(payload);
      return JSON.stringify({
        type: "base64",
        file: { filePath: payload.file_path, content: Buffer.from([1, 2, 3]).toString("base64") },
        meta: { mtimeMs: 123, totalBytes: 3, readBytes: 3 }
      });
    })
  });

  try {
    process.chdir(root);
    const result = await tools.execute({ id: "read_image", toolName: "Read", input: { file_path: "/workspace/photo.png" } });

    assert.equal(result.ok, false);
    assert.equal(calls[0]?.operation, "base64");
  } finally {
    process.chdir(cwd);
  }
});

test("Read wrapper returns structured base64 for image files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-image-read-"));
  const filePath = path.join(root, "photo.png");
  fs.writeFileSync(filePath, Buffer.from([1, 2, 3]));

  const output = await runReadTool({ operation: "base64", file_path: filePath, allowed_roots: [root], cwd: root });

  assert.equal(output.type, "base64");
  assert.equal(output.file.content, Buffer.from([1, 2, 3]).toString("base64"));
  assert.equal(output.meta.totalBytes, 3);
});

test("Read returns file_unchanged for the same full read and mtime", async () => {
  let calls = 0;
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async (payload) => {
      calls += 1;
      if (payload.operation === "mtime") return mtimeOutput(String(payload.file_path), 777);
      return readOutput(String(payload.file_path), calls === 1 ? "one\ntwo" : "changed", calls === 1 ? 2 : 1, 777);
    })
  });

  const first = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "/workspace/notes.txt" } });
  const second = await tools.execute({ id: "read_2", toolName: "Read", input: { file_path: "/workspace/notes.txt" } });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 2);
});

test("Read rejects paths outside sandbox roots before calling runtime", async () => {
  let called = false;
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async () => {
      called = true;
      return readOutput("/etc/passwd", "root", 1, 1);
    })
  });

  const result = await tools.execute({ id: "read_outside", toolName: "Read", input: { file_path: "/etc/passwd" } });

  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("Edit passes prior full Read state to sandbox tool and updates state", async () => {
  const calls: Array<{ toolName: string; payload: Record<string, unknown> }> = [];
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async (payload, toolName) => {
      calls.push({ toolName, payload });
      if (toolName === "Edit") {
        assert.deepEqual(payload.read_state, calls.length === 2
          ? { content: "old", timestamp: 123, offset: 1, limit: undefined }
          : { content: "new", timestamp: 124, offset: undefined, limit: undefined });
        return JSON.stringify({ type: "edit", file: { filePath: payload.file_path, content: "new" }, meta: { mtimeMs: 124 }, message: `The file ${payload.file_path} has been updated successfully.` });
      }
      return readOutput(String(payload.file_path), "old", 1, 123);
    })
  });

  await tools.execute({ id: "read", toolName: "Read", input: { file_path: "/workspace/notes.txt" } });
  const edit = await tools.execute({ id: "edit", toolName: "Edit", input: { file_path: "/workspace/notes.txt", old_string: "old", new_string: "new" } });
  await tools.execute({ id: "edit2", toolName: "Edit", input: { file_path: "/workspace/notes.txt", old_string: "new", new_string: "newer" } });

  assert.equal(edit.ok, true);
  assert.deepEqual(calls.map((call) => call.toolName), ["Read", "Edit", "Edit"]);
});

test("Edit accepts state from a ranged Read", async () => {
  const calls: Array<{ toolName: string; payload: Record<string, unknown> }> = [];
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async (payload, toolName) => {
      calls.push({ toolName, payload });
      if (toolName === "Edit") {
        assert.deepEqual(payload.read_state, { content: "target", timestamp: 123, offset: 2, limit: 1 });
        return JSON.stringify({ type: "edit", file: { filePath: payload.file_path, content: "updated" }, meta: { mtimeMs: 124 }, message: "ok" });
      }
      return readOutput(String(payload.file_path), "target", 1, 123);
    })
  });

  await tools.execute({ id: "read_range", toolName: "Read", input: { file_path: "/workspace/notes.txt", offset: 2, limit: 1 } });
  const edit = await tools.execute({ id: "edit", toolName: "Edit", input: { file_path: "/workspace/notes.txt", old_string: "target", new_string: "updated" } });

  assert.equal(edit.ok, true);
  assert.deepEqual(calls.map((call) => call.toolName), ["Read", "Edit"]);
});

test("Read does not return file_unchanged from Edit-updated state", async () => {
  const calls: Array<{ toolName: string; payload: Record<string, unknown> }> = [];
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async (payload, toolName) => {
      calls.push({ toolName, payload });
      if (toolName === "Edit") {
        return JSON.stringify({ type: "edit", file: { filePath: payload.file_path, content: "new" }, meta: { mtimeMs: 124 }, message: "ok" });
      }
      if (payload.operation === "mtime") return mtimeOutput(String(payload.file_path), 124);
      return readOutput(String(payload.file_path), calls.length === 1 ? "old" : "new", 1, calls.length === 1 ? 123 : 124);
    })
  });

  await tools.execute({ id: "read", toolName: "Read", input: { file_path: "/workspace/notes.txt" } });
  await tools.execute({ id: "edit", toolName: "Edit", input: { file_path: "/workspace/notes.txt", old_string: "old", new_string: "new" } });
  const reread = await tools.execute({ id: "reread", toolName: "Read", input: { file_path: "/workspace/notes.txt" } });

  assert.equal(reread.ok, true);
  assert.deepEqual(calls.map((call) => call.toolName), ["Read", "Edit", "Read"]);
});

test("Edit allows empty old_string and empty new_string", async () => {
  const calls: Record<string, unknown>[] = [];
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async (payload, toolName) => {
      assert.equal(toolName, "Edit");
      calls.push(payload);
      return JSON.stringify({
        type: "edit",
        file: { filePath: payload.file_path, content: payload.new_string },
        meta: { mtimeMs: 124 },
        message: "ok"
      });
    })
  });

  const create = await tools.execute({ id: "edit_create", toolName: "Edit", input: { file_path: "/workspace/empty.txt", old_string: "", new_string: "hello" } });
  const deleteText = await tools.execute({ id: "edit_delete", toolName: "Edit", input: { file_path: "/workspace/notes.txt", old_string: "hello", new_string: "" } });

  assert.equal(create.ok, true);
  assert.equal(deleteText.ok, true);
  assert.equal(calls[0]?.old_string, "");
  assert.equal(calls[0]?.new_string, "hello");
  assert.equal(calls[1]?.old_string, "hello");
  assert.equal(calls[1]?.new_string, "");
});

test("Glob and Grep return sandbox formatted content", async () => {
  const tools = createFileTools({
    config: testConfig(),
    runtime: fakeRuntime(async (_payload, toolName) => {
      if (toolName === "Glob") return JSON.stringify({ type: "glob", content: "a.txt\nb.txt" });
      if (toolName === "Grep") return JSON.stringify({ type: "grep", content: "Found 1 file\na.txt" });
      return readOutput("/workspace/notes.txt", "one", 1, 1);
    })
  });

  const glob = await tools.execute({ id: "glob", toolName: "Glob", input: { pattern: "**/*.txt", path: "/workspace" } });
  const grep = await tools.execute({ id: "grep", toolName: "Grep", input: { pattern: "needle", path: "/workspace" } });

  assert.equal(glob.ok, true);
  assert.equal(grep.ok, true);
});

function fakeRuntime(read: (payload: Record<string, unknown>, toolName: "Read" | "Edit" | "Glob" | "Grep") => Promise<string> | string): BashSandboxRuntime {
  return {
    mountSkill(mount) {
      return mount;
    },
    async run() {
      throw new Error("unused");
    },
    async runFileTool(input) {
      return {
        stdout: await read(input.payload, input.toolName),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        truncated: false
      };
    },
    async readFile(input) {
      return this.runFileTool({ toolName: "Read", ...input });
    }
  };
}

function readOutput(filePath: string, content: string, numLines: number, mtimeMs: number): string {
  return JSON.stringify({
    type: "text",
    file: { filePath, content, numLines, startLine: 1, totalLines: numLines },
    meta: { mtimeMs, totalBytes: Buffer.byteLength(content), readBytes: Buffer.byteLength(content) }
  });
}

function mtimeOutput(filePath: string, mtimeMs: number): string {
  return JSON.stringify({ type: "mtime", file: { filePath }, mtimeMs });
}
