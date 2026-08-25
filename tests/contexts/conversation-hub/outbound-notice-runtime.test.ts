import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutboundNoticeRuntime } from "../../../src/contexts/conversation-hub/src/application/outbound-notice-runtime.js";

test("outboundNotice_memoryFailure_usesConcreteErrorWithoutJsonOrTraceback", async () => {
  const sent: Array<{ content: unknown }> = [];
  const stored: Array<{ contentText: string }> = [];
  const runtime = createOutboundNoticeRuntime({
    time: {
      timeZone: "Asia/Tokyo",
      now() {
        return { iso: "2026-08-26T10:00:00.000", date: new Date("2026-08-26T01:00:00.000Z") };
      }
    },
    outputRouter: {
      async send(output) {
        sent.push(output as { content: unknown });
        return undefined;
      }
    },
    getStore() {
      return {
        insertOutboundMessage(input: { contentText: string }) {
          stored.push(input);
          return { id: 1 };
        },
        markOutboundMessageSent() {},
        markOutboundMessageFailed() {}
      };
    },
    getDefaultTarget() {
      return undefined;
    },
    getDefaultFeishuTarget() {
      return { plugin: "feishu", accountId: "main", channelId: "chat", sessionId: "session-1" };
    },
    appendMessageLog() {}
  });

  await runtime.sendMemoryFailureNoticeToFeishu(new Error(
    "LLM request failed: 503 Service Unavailable {\"error\":{\"type\":\"server_error\",\"message\":\"Error from provider (Console Go): Upstream request failed: Endpoint is unavailable.\"}}"
  ));

  assert.equal(stored[0]?.contentText, "Error: LLM request failed: 503 Service Unavailable | Error from provider (Console Go): Upstream request failed: Endpoint is unavailable.");
  assert.equal((sent[0]?.content as { kind: string; text: string }).text, "<-Error: LLM request failed: 503 Service Unavailable | Error from provider (Console Go): Upstream request failed: Endpoint is unavailable.->");
  assert.doesNotMatch((sent[0]?.content as { kind: string; text: string }).text, /\{\"error\"/);
  assert.doesNotMatch((sent[0]?.content as { kind: string; text: string }).text, /at .*\.ts:\d+/);
});
