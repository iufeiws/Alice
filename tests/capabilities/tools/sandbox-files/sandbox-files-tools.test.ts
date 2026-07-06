import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxFileTools } from "../../../../src/capabilities/tools/sandbox-files/src/index.js";
import type { BashSandboxRuntime } from "../../../../src/contexts/bash-sandbox/src/index.js";
import { testConfig } from "../../../contexts/bash-sandbox/bash-sandbox-helpers.js";

test("Read runs against an absolute sandbox path", async () => {
  const calls: Record<string, unknown>[] = [];
  const tools = createSandboxFileTools({
    config: testConfig(),
    runtime: fakeReadRuntime(async (payload) => {
      calls.push(payload);
      return readOutput(String(payload.file_path), "one\ntwo", 2, 123);
    })
  });

  const result = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "/workspace/notes.txt", offset: 1, limit: 2 } });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file_path, "/workspace/notes.txt");
  assert.equal(result.output, "1\tone\n2\ttwo");
});

test("Read rejects paths outside the sandbox roots before calling runtime", async () => {
  let called = false;
  const tools = createSandboxFileTools({
    config: testConfig(),
    runtime: fakeReadRuntime(async () => {
      called = true;
      return readOutput("/etc/passwd", "root", 1, 1);
    })
  });

  const result = await tools.execute({ id: "read_outside", toolName: "Read", input: { file_path: "/etc/passwd" } });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /outside configured sandbox/);
  assert.equal(called, false);
});

test("Read returns file_unchanged for the same range and mtime", async () => {
  let calls = 0;
  const tools = createSandboxFileTools({
    config: testConfig(),
    runtime: fakeReadRuntime(async (payload) => {
      calls += 1;
      if (payload.operation === "mtime") return mtimeOutput(String(payload.file_path), 777);
      return readOutput(String(payload.file_path), calls === 1 ? "one\ntwo" : "one", calls === 1 ? 2 : 1, 777);
    })
  });

  const first = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "/workspace/notes.txt", offset: 1 } });
  const second = await tools.execute({ id: "read_2", toolName: "Read", input: { file_path: "/workspace/notes.txt", offset: 1 } });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.output, "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.");
  assert.equal(calls, 2);
});

test("Read dedup is controlled by tengu_read_dedup_killswitch", async () => {
  const previous = process.env.tengu_read_dedup_killswitch;
  process.env.tengu_read_dedup_killswitch = "true";
  let calls = 0;
  try {
    const tools = createSandboxFileTools({
      config: testConfig(),
      runtime: fakeReadRuntime(async (payload) => {
        calls += 1;
        if (payload.operation === "mtime") return mtimeOutput(String(payload.file_path), 777);
        return readOutput(String(payload.file_path), calls === 1 ? "one" : "two", 1, 777);
      })
    });

    const first = await tools.execute({ id: "read_1", toolName: "Read", input: { file_path: "/workspace/notes.txt" } });
    const second = await tools.execute({ id: "read_2", toolName: "Read", input: { file_path: "/workspace/notes.txt" } });

    assert.equal(first.output, "1\tone");
    assert.equal(second.output, "1\ttwo");
    assert.equal(calls, 2);
  } finally {
    if (previous === undefined) delete process.env.tengu_read_dedup_killswitch;
    else process.env.tengu_read_dedup_killswitch = previous;
  }
});

test("sandbox file tools exposes Edit Glob and Grep", () => {
  const tools = createSandboxFileTools({
    config: testConfig(),
    runtime: fakeReadRuntime(async () => readOutput("/workspace/notes.txt", "one", 1, 1))
  });

  assert.deepEqual(tools.listTools().map((tool) => tool.name), ["Read", "Edit", "Glob", "Grep"]);
});

test("Edit passes prior full Read state to the sandbox tool and updates state", async () => {
  const calls: Array<{ toolName: string; payload: Record<string, unknown> }> = [];
  const tools = createSandboxFileTools({
    config: testConfig(),
    runtime: fakeReadRuntime(async (payload, toolName) => {
      calls.push({ toolName, payload });
      if (toolName === "Edit") {
        assert.deepEqual(payload.read_state, { content: "old", timestamp: 123, offset: undefined, limit: undefined, isPartialView: false });
        return JSON.stringify({ type: "edit", file: { filePath: payload.file_path, content: "new" }, meta: { mtimeMs: 124 }, message: `The file ${payload.file_path} has been updated successfully.` });
      }
      return readOutput(String(payload.file_path), "old", 1, 123);
    })
  });

  await tools.execute({ id: "read", toolName: "Read", input: { file_path: "/workspace/notes.txt" } });
  const edit = await tools.execute({ id: "edit", toolName: "Edit", input: { file_path: "/workspace/notes.txt", old_string: "old", new_string: "new" } });

  assert.equal(edit.ok, true);
  assert.equal(edit.output, "The file /workspace/notes.txt has been updated successfully.");
  assert.deepEqual(calls.map((call) => call.toolName), ["Read", "Edit"]);
});

test("Glob and Grep return sandbox formatted content", async () => {
  const tools = createSandboxFileTools({
    config: testConfig(),
    runtime: fakeReadRuntime(async (_payload, toolName) => {
      if (toolName === "Glob") return JSON.stringify({ type: "glob", content: "a.txt\nb.txt" });
      if (toolName === "Grep") return JSON.stringify({ type: "grep", content: "Found 1 file\na.txt" });
      return readOutput("/workspace/notes.txt", "one", 1, 1);
    })
  });

  const glob = await tools.execute({ id: "glob", toolName: "Glob", input: { pattern: "**/*.txt", path: "/workspace" } });
  const grep = await tools.execute({ id: "grep", toolName: "Grep", input: { pattern: "needle", path: "/workspace" } });

  assert.equal(glob.output, "a.txt\nb.txt");
  assert.equal(grep.output, "Found 1 file\na.txt");
});

function fakeReadRuntime(read: (payload: Record<string, unknown>, toolName: "Read" | "Edit" | "Glob" | "Grep") => Promise<string> | string): BashSandboxRuntime {
  return {
    setReporter() {},
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
