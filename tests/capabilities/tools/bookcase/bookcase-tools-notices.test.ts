import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookcaseTools } from "../../../../src/capabilities/tools/bookcase/src/index.js";
import { createFixtureDb, fixedTime, fixtureCounts } from "./bookcase-tools-helpers.js";

const baseCall = {
  requester: { plugin: "feishu", channelId: "chat-1" },
  externalSession: { scope: "dm" as const, sessionId: "session-1" }
};

test("bookcase notices are sent and logged without persisting messages", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);
  const sent: string[] = [];
  const stored: Array<{ contentText: string; senderRole?: string }> = [];
  const logs: Array<{ status?: string; summary: string }> = [];
  const store = {
    insertOutboundMessage(input: any) {
      stored.push({ contentText: input.contentText, senderRole: input.senderRole });
      return { id: stored.length, ...input };
    },
    markOutboundMessageSent() {},
    markOutboundMessageFailed() {}
  };
  const tools = createBookcaseTools({
    dbPath,
    time: fixedTime(),
    store,
    outputRouter: {
      async send(output) {
        sent.push(output.content.kind === "text" ? output.content.text : "");
        return { messageId: `notice_${sent.length}` };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    }
  });

  await tools.execute({
    ...baseCall,
    id: "call_bookcase_draw_notice",
    toolName: "Bookcase",
    input: { action: "draw", seed: 1, minSummaryChars: 10 }
  });
  await tools.execute({
    ...baseCall,
    id: "call_bookcase_return_notice",
    toolName: "Bookcase",
    input: { action: "return" }
  });

  assert.deepEqual(sent, ["-少女已取书-", "-少女已还书-"]);
  assert.deepEqual(stored, []);
  assert.deepEqual(logs, [
    { status: "sent", summary: "-少女已取书-" },
    { status: "sent", summary: "-少女已还书-" }
  ]);
  assert.deepEqual(fixtureCounts(dbPath), before);
});

test("bookcase notice failures are logged without blocking draw or return", async () => {
  const dbPath = createFixtureDb();
  const before = fixtureCounts(dbPath);
  const stored: unknown[] = [];
  const logs: Array<{ status?: string; summary: string; error?: string }> = [];
  const store = {
    insertOutboundMessage(input: any) {
      stored.push(input);
      return { id: stored.length, ...input };
    },
    markOutboundMessageSent() {},
    markOutboundMessageFailed() {}
  };
  const tools = createBookcaseTools({
    dbPath,
    time: fixedTime(),
    store,
    outputRouter: {
      async send() {
        throw new Error("notice offline");
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary, error: input.error });
    }
  });

  const draw = await tools.execute({
    ...baseCall,
    id: "call_bookcase_draw_notice_failed",
    toolName: "Bookcase",
    input: { action: "draw", seed: 1, minSummaryChars: 10 }
  });
  const returned = await tools.execute({
    ...baseCall,
    id: "call_bookcase_return_notice_failed",
    toolName: "Bookcase",
    input: { action: "return" }
  });

  assert.equal(draw.ok, true);
  assert.equal(draw.resetLLMSession, true);
  assert.equal(draw.fixedPrefixKind, "bookcase");
  assert.equal(returned.ok, true);
  assert.equal(returned.resetLLMSession, true);
  assert.equal(returned.clearFixedPrefix, true);
  assert.deepEqual(stored, []);
  assert.deepEqual(logs, [
    { status: "send_failed", summary: "-少女已取书-", error: "notice offline" },
    { status: "send_failed", summary: "-少女已还书-", error: "notice offline" }
  ]);
  assert.deepEqual(fixtureCounts(dbPath), before);
});
