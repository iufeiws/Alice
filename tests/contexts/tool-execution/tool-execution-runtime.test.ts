import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeRegisteredTool,
  getRegisteredToolDefinition,
  registerToolPlugins,
  setToolExecutionReporter
} from "../../../src/contexts/tool-execution/src/index.js";

test("tool registry owns definition lookup, execution, and unregister lifecycle", async () => {
  const unregister = registerToolPlugins("registry-lifecycle-test", [{
    id: "test",
    listTools: () => [{ name: "Echo", description: "echo", inputSchema: { type: "object" } }],
    async execute(call) {
      return { callId: call.id, ok: true, output: call.input };
    }
  }]);

  assert.equal(getRegisteredToolDefinition("registry-lifecycle-test", "Echo")?.description, "echo");
  assert.deepEqual(await executeRegisteredTool("registry-lifecycle-test", {
    id: "echo",
    toolName: "Echo",
    input: { value: 1 }
  }), {
    callId: "echo",
    ok: true,
    output: { value: 1 }
  });

  unregister();
  assert.equal(getRegisteredToolDefinition("registry-lifecycle-test", "Echo"), undefined);
  await assert.rejects(
    async () => executeRegisteredTool("registry-lifecycle-test", { id: "missing", toolName: "Echo", input: {} }),
    /llm_tool_unavailable:Echo/
  );
});

test("registered tool execution reports progress unless its profile suppresses the card", async () => {
  const events: string[] = [];
  setToolExecutionReporter({
    endSequence() {},
    begin(call) {
      events.push(`begin:${call.toolName}`);
      return {
        appendProgress(content) { events.push(`progress:${content}`); },
        finish(result) { events.push(`finish:${result.callId}`); },
        fail(error) { events.push(`fail:${String(error)}`); }
      };
    }
  });
  registerToolPlugins("tool-report-test", [{
    id: "test",
    listTools: () => [
      { name: "Visible", description: "visible", inputSchema: {} },
      { name: "Hidden", description: "hidden", inputSchema: {}, suppressExecutionCard: true }
    ],
    async execute(call, context) {
      context?.reportProgress?.("working");
      return { callId: call.id, ok: true };
    }
  }]);

  try {
    await executeRegisteredTool("tool-report-test", { id: "visible", toolName: "Visible", input: {} });
    await executeRegisteredTool("tool-report-test", { id: "hidden", toolName: "Hidden", input: {} });
  } finally {
    setToolExecutionReporter(undefined);
  }

  assert.deepEqual(events, ["begin:Visible", "progress:working", "finish:visible"]);
});

test("registered tool execution omits blank optional inputs according to the tool schema", async () => {
  const received: Array<Record<string, unknown>> = [];
  registerToolPlugins("blank-optional-input-test", [{
    id: "test",
    listTools: () => [{
      name: "Defaults",
      description: "defaults",
      inputSchema: {
        type: "object",
        properties: {
          requiredText: { type: "string" },
          optionalText: { type: "string" },
          keptText: { type: "string" },
          nested: {
            type: "object",
            properties: {
              optionalText: { type: "string" },
              requiredText: { type: "string" }
            },
            required: ["requiredText"]
          },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: { optionalText: { type: "string" } }
            }
          }
        },
        required: ["requiredText"]
      }
    }],
    async execute(call) {
      received.push(call.input);
      return { callId: call.id, ok: true };
    }
  }]);

  const originalInput = {
    requiredText: " ",
    optionalText: "\t\n",
    keptText: " value ",
    nested: { optionalText: "", requiredText: "" },
    entries: [{ optionalText: "  " }],
    unknown: ""
  };
  await executeRegisteredTool("blank-optional-input-test", {
    id: "blank-input",
    toolName: "Defaults",
    input: originalInput
  });

  assert.deepEqual(received, [{
    requiredText: " ",
    keptText: " value ",
    nested: { requiredText: "" },
    entries: [{}],
    unknown: ""
  }]);
  assert.deepEqual(originalInput, {
    requiredText: " ",
    optionalText: "\t\n",
    keptText: " value ",
    nested: { optionalText: "", requiredText: "" },
    entries: [{ optionalText: "  " }],
    unknown: ""
  });
});
