import test from "node:test";
import assert from "node:assert/strict";
import {
  type PiRawMessage,
  accessMessages,
  isVisibleMessage,
  parseMessageAccess,
  projectLatestAssistantOutcomeAfter,
  projectLatestAssistantMessageAfter,
  projectRawMessages,
  projectVisibleMessages
} from "../../../src/contexts/pi-worker/runtime/message-projection.mjs";

// Fixtures mirror the shapes observed in real Pi JSONL sessions
// (e.g. 2026-08-06T13-43-50-970Z_019fd750-e5b9-7a31-9336-55fbc214b021.jsonl):
// tool-calling turns store `thinking`/`text`/`toolCall` content blocks, and
// streaming artifacts persist as assistant entries with an empty content array.
const REAL_SESSION_ENTRIES = [
  { id: "inv-1", type: "custom", customType: "alice_pi_invocation", data: { message: "task" } },
  { id: "m1", type: "message", message: { role: "user", content: [{ type: "text", text: "请查找今天的会议转录文件" }] } },
  { id: "m2", type: "message", message: { role: "assistant", content: [] } },
  { id: "m3", type: "message", message: { role: "assistant", content: [
    { type: "thinking", thinking: "先探索工具" },
    { type: "text", text: "我来帮你查找" },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
    { type: "toolCall", id: "call-2", name: "read", arguments: { path: "a.txt" } }
  ] } },
  { id: "m4", type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "file list" }] } },
  { id: "m5", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "bash", arguments: {} }] } },
  { id: "m6", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "思考中" }] } },
  { id: "m7", type: "message", message: { role: "user", content: [{ type: "text", text: "继续" }] } },
  { id: "m8", type: "message", message: { role: "assistant", content: [{ type: "text", text: "最终答案" }] } },
  { id: "m9", type: "message", message: { role: "assistant", content: [] } }
];

test("isVisibleMessage: user messages stay visible regardless of shape", () => {
  assert.equal(isVisibleMessage({ role: "user", content: [{ type: "text", text: "hi" }] }), true);
  assert.equal(isVisibleMessage({ role: "user", content: "" }), true);
});

test("isVisibleMessage: assistant tool-use messages are dropped", () => {
  const text = { type: "text", text: "doing it" };
  const toolCall = { type: "toolCall", id: "c1", name: "bash", arguments: {} };
  assert.equal(isVisibleMessage({ role: "assistant", content: [text, toolCall] }), false);
  assert.equal(isVisibleMessage({ role: "assistant", content: [toolCall] }), false);
  assert.equal(isVisibleMessage({ role: "assistant", content: [text], toolCalls: [{ id: "c1" }] }), false);
  assert.equal(isVisibleMessage({ role: "assistant", content: "text", toolCalls: [{ id: "c1" }] }), false);
});

test("isVisibleMessage: thinking blocks are stripped before visibility, progress/tool-result blocks still drop the message", () => {
  assert.equal(isVisibleMessage({ role: "assistant", content: [{ type: "thinking", thinking: "…" }] }), false);
  assert.equal(isVisibleMessage({ role: "assistant", content: [{ type: "text", text: "t" }, { type: "progress" }] }), false);
  assert.equal(isVisibleMessage({ role: "assistant", content: [{ type: "tool_result", output: "x" }] }), false);
});

test("isVisibleMessage: assistant messages with thinking plus text stay visible", () => {
  assert.equal(isVisibleMessage({ role: "assistant", content: [{ type: "thinking", thinking: "思考" }, { type: "text", text: "最终答案" }] }), true);
  assert.equal(isVisibleMessage({ role: "assistant", content: [{ type: "text", text: "最终答案" }, { type: "thinking", thinking: "思考" }] }), true);
});

test("isVisibleMessage: assistant messages without non-empty text are dropped", () => {
  assert.equal(isVisibleMessage({ role: "assistant", content: [] }), false);
  assert.equal(isVisibleMessage({ role: "assistant", content: "" }), false);
  assert.equal(isVisibleMessage({ role: "assistant", content: [{ type: "text", text: "" }] }), false);
  assert.equal(isVisibleMessage({ role: "assistant", content: [{ type: "text", text: "   " }] }), false);
});

test("isVisibleMessage: plain assistant text stays visible", () => {
  assert.equal(isVisibleMessage({ role: "assistant", content: [{ type: "text", text: "done" }] }), true);
  assert.equal(isVisibleMessage({ role: "assistant", content: "done" }), true);
});

test("projectVisibleMessages filters to visible user/assistant messages only", () => {
  assert.deepEqual(projectVisibleMessages(REAL_SESSION_ENTRIES), [
    { role: "user", content: [{ type: "text", text: "请查找今天的会议转录文件" }] },
    { role: "user", content: [{ type: "text", text: "继续" }] },
    { role: "assistant", content: [{ type: "text", text: "最终答案" }] }
  ]);
});

test("projectRawMessages preserves every Pi message object without visibility filtering", () => {
  assert.deepEqual(projectRawMessages(REAL_SESSION_ENTRIES), REAL_SESSION_ENTRIES
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message));
});

test("projectVisibleMessages strips thinking blocks from visible assistant content", () => {
  const entries = [
    { id: "m1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "思考" }, { type: "text", text: "答复" }] } }
  ];
  assert.deepEqual(projectVisibleMessages(entries), [
    { role: "assistant", content: [{ type: "text", text: "答复" }] }
  ]);
});

test("projectLatestAssistantMessageAfter ignores tool-use and empty assistant messages", () => {
  const entries = REAL_SESSION_ENTRIES;
  assert.deepEqual(projectLatestAssistantMessageAfter(entries, "m7"), { role: "assistant", content: [{ type: "text", text: "最终答案" }] });
  assert.deepEqual(projectLatestAssistantMessageAfter(entries, "m1"), { role: "assistant", content: [{ type: "text", text: "最终答案" }] });
  assert.equal(projectLatestAssistantMessageAfter(entries, "m9"), undefined);
  assert.equal(projectLatestAssistantMessageAfter(entries, "missing"), undefined);
});

test("projectLatestAssistantMessageAfter returns text even when the reply carries thinking blocks", () => {
  const entries = [
    { id: "inv-1", type: "custom", customType: "alice_pi_invocation", data: { message: "task" } },
    { id: "m1", type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { id: "m2", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "思考" }, { type: "text", text: "答复" }] } }
  ];
  assert.deepEqual(projectLatestAssistantMessageAfter(entries, "inv-1"), { role: "assistant", content: [{ type: "text", text: "答复" }] });
});

test("projectLatestAssistantOutcomeAfter uses the final assistant terminal from the end", () => {
  const recovered = [
    { id: "inv-1", type: "custom", customType: "alice_pi_invocation", data: { message: "task" } },
    { id: "m1", type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "upstream failed" } },
    { id: "m2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "later" }] } },
    { id: "inv-2", type: "custom", customType: "alice_pi_invocation", data: { message: "next task" } }
  ];
  assert.deepEqual(projectLatestAssistantOutcomeAfter(recovered, "inv-1"), { status: "completed", text: "later" });

  const laterError = [
    { id: "inv-1", type: "custom", customType: "alice_pi_invocation", data: { message: "task" } },
    { id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier" }] } },
    { id: "m2", type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "later failure" } },
    { id: "inv-2", type: "custom", customType: "alice_pi_invocation", data: { message: "next task" } }
  ];
  assert.deepEqual(projectLatestAssistantOutcomeAfter(laterError, "inv-1"), { status: "failed", text: "later failure" });
  assert.equal(projectLatestAssistantOutcomeAfter(recovered, "missing"), undefined);
});

test("parseMessageAccess accepts integer and start:end slice only", () => {
  assert.deepEqual(parseMessageAccess("-1"), { kind: "index", index: -1 });
  assert.deepEqual(parseMessageAccess(":3"), { kind: "slice", start: undefined, end: 3 });
  assert.deepEqual(parseMessageAccess("2:"), { kind: "slice", start: 2, end: undefined });
  assert.deepEqual(parseMessageAccess("1:3"), { kind: "slice", start: 1, end: 3 });
  assert.deepEqual(parseMessageAccess(":"), { kind: "slice", start: undefined, end: undefined });
  assert.throws(() => parseMessageAccess("1:2:3"), /invalid_subagent_message_access/);
  assert.throws(() => parseMessageAccess("1.5"), /invalid_subagent_message_access/);
  assert.throws(() => parseMessageAccess("a"), /invalid_subagent_message_access/);
  assert.throws(() => parseMessageAccess(""), /invalid_subagent_message_access/);
  assert.throws(() => parseMessageAccess(undefined), /invalid_subagent_message_access/);
});

test("accessMessages applies Python index semantics without changing message objects", () => {
  const messages: PiRawMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: [{ type: "thinking", thinking: "private" }], stopReason: "length" },
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "c" }] }
  ];
  assert.deepEqual(accessMessages(messages, "-1"), [messages[2]]);
  assert.deepEqual(accessMessages(messages, "0"), [messages[0]]);
  assert.deepEqual(accessMessages(messages, "2"), [messages[2]]);
  assert.throws(() => accessMessages(messages, "3"), /subagent_message_access_out_of_range/);
  assert.throws(() => accessMessages(messages, "-4"), /subagent_message_access_out_of_range/);
  assert.deepEqual(accessMessages(messages, ":2"), messages.slice(0, 2));
  assert.deepEqual(accessMessages(messages, "1:"), messages.slice(1));
  assert.deepEqual(accessMessages(messages, "1:3"), messages.slice(1, 3));
  assert.deepEqual(accessMessages(messages, ":"), messages);
  // Slices clamp out-of-range bounds instead of throwing (Python slice semantics).
  assert.deepEqual(accessMessages(messages, "5:"), []);
  assert.deepEqual(accessMessages(messages, ":99"), messages);
});
