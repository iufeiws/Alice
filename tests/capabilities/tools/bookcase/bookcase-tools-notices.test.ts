import { test } from "node:test";
import { testPromptRuntime } from "../../../helpers/prompt-runtime.js";
import assert from "node:assert/strict";
import { createBookcaseTools } from "../../../../src/capabilities/tools/bookcase/src/index.js";
import { createFixtureDb, fixedTime } from "./bookcase-tools-helpers.js";

const baseCall = {
  requester: { plugin: "feishu", channelId: "chat-1" },
  externalSession: { scope: "dm" as const, sessionId: "session-1" }
};

test("bookcase draw sends a system notice", async () => {
  const dbPath = createFixtureDb();
  const sent: string[] = [];
  const stored: Array<{ contentText: string; senderRole?: string }> = [];
  const store = {
    insertOutboundMessage(input: any) {
      stored.push({ contentText: input.contentText, senderRole: input.senderRole });
      return { id: stored.length, ...input };
    },
    markOutboundMessageSent() {},
    markOutboundMessageFailed() {}
  };
  const tools = createBookcaseTools({ promptContextRuntime: testPromptRuntime(),
    dbPath,
    time: fixedTime(),
    store,
    outputRouter: {
      async send(output) {
        sent.push(output.content.kind === "text" ? output.content.text : "");
        return { messageId: `notice_${sent.length}` };
      }
    },
    appendMessageLog() {}
  });

  await tools.execute({
    ...baseCall,
    id: "call_bookcase_draw_notice",
    toolName: "Bookcase",
    input: { action: "draw", seed: 1, minSummaryChars: 10 }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0], "<-少女已取书->");
  assert.deepEqual(stored, [{ contentText: "少女已取书", senderRole: "system" }]);
});

test("bookcase return sends a system notice", async () => {
  const dbPath = createFixtureDb();
  const sent: string[] = [];
  const stored: Array<{ contentText: string; senderRole?: string }> = [];
  const store = {
    insertOutboundMessage(input: any) {
      stored.push({ contentText: input.contentText, senderRole: input.senderRole });
      return { id: stored.length, ...input };
    },
    markOutboundMessageSent() {},
    markOutboundMessageFailed() {}
  };
  const tools = createBookcaseTools({ promptContextRuntime: testPromptRuntime(),
    dbPath,
    time: fixedTime(),
    store,
    outputRouter: {
      async send(output) {
        sent.push(output.content.kind === "text" ? output.content.text : "");
        return { messageId: `notice_${sent.length}` };
      }
    },
    appendMessageLog() {}
  });

  await tools.execute({
    ...baseCall,
    id: "call_bookcase_return_notice",
    toolName: "Bookcase",
    input: { action: "return" }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0], "<-少女已还书->");
  assert.deepEqual(stored, [{ contentText: "少女已还书", senderRole: "system" }]);
});

test("bookcase sent notices are logged", async () => {
  const dbPath = createFixtureDb();
  const logs: Array<{ status?: string; summary: string }> = [];
  const store = {
    insertOutboundMessage(input: any) {
      return { id: 1, ...input };
    },
    markOutboundMessageSent() {},
    markOutboundMessageFailed() {}
  };
  const tools = createBookcaseTools({ promptContextRuntime: testPromptRuntime(),
    dbPath,
    time: fixedTime(),
    store,
    outputRouter: {
      async send() {
        return { messageId: "notice_1" };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    }
  });

  await tools.execute({
    ...baseCall,
    id: "call_bookcase_draw_notice_log",
    toolName: "Bookcase",
    input: { action: "draw", seed: 1, minSummaryChars: 10 }
  });

  assert.deepEqual(logs.map((entry) => entry.status), ["sent"]);
});

test("bookcase draw continues when notice sending fails", async () => {
  const dbPath = createFixtureDb();
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
  const tools = createBookcaseTools({ promptContextRuntime: testPromptRuntime(),
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

  assert.equal(draw.ok, true);
  assert.equal(draw.resetLLMSession, true);
  assert.equal(draw.fixedPrefixKind, "bookcase");
  assert.deepEqual(stored.map((entry: any) => ({ contentText: entry.contentText, senderRole: entry.senderRole })), [{ contentText: "少女已取书", senderRole: "system" }]);
  assert.deepEqual(logs.map((entry) => entry.status), ["send_failed"]);
});

test("bookcase return continues when notice sending fails", async () => {
  const dbPath = createFixtureDb();
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
  const tools = createBookcaseTools({ promptContextRuntime: testPromptRuntime(),
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

  const returned = await tools.execute({
    ...baseCall,
    id: "call_bookcase_return_notice_failed",
    toolName: "Bookcase",
    input: { action: "return" }
  });

  assert.equal(returned.ok, true);
  assert.equal(returned.resetLLMSession, true);
  assert.equal(returned.clearFixedPrefix, true);
  assert.deepEqual(stored.map((entry: any) => ({ contentText: entry.contentText, senderRole: entry.senderRole })), [{ contentText: "少女已还书", senderRole: "system" }]);
  assert.deepEqual(logs.map((entry) => entry.status), ["send_failed"]);
});
