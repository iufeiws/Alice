import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../apps/api/src/message-runtime.js";
import { createAliceStore, type StoredMessageLog } from "../packages/storage/src/sqlite-store.js";
import type { AgentEvent, AgentOutput } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("message runtime sends one LLM request for pending inbound logs and marks them processed", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const outputs: AgentOutput[] = [textOutput("session-1", "ok")];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return outputs;
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  runtime.ingestEvent(textEvent("session-1", "om_2", "world"));
  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].payload.kind, "text");
  assert.ok(coreInputs[0].payload.kind === "text" && coreInputs[0].payload.text.includes("hello\nworld"));
  assert.equal(store.listUnprocessedInboundForSession("session-1", 10).length, 0);
  assert.equal(store.listMessageLogsForSession("session-1", 10).filter((entry) => entry.direction === "outbound").length, 1);
});

test("message runtime keeps inbound unprocessed when handling fails", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-fail"), "alice.sqlite"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent() {
        throw new Error("llm failed");
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(store.listUnprocessedInboundForSession("session-1", 10).length, 1);
});

test("message runtime can recover pending sessions from storage", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-recover"), "alice.sqlite"));
  store.insertMessageLog({
    time: "2026-05-24T00:00:00.000Z",
    direction: "inbound",
    plugin: "feishu",
    kind: "text",
    target: "chat",
    sessionId: "session-1",
    rawMessageId: "om_1",
    summary: "recover me"
  });
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.recoverPendingSessions();
  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].meta.replyTo, "om_1");
  assert.equal(store.listUnprocessedInboundForSession("session-1", 10).length, 0);
});

function textEvent(sessionId: string, rawMessageId: string, text: string): AgentEvent {
  return {
    id: `evt_${rawMessageId}`,
    source: {
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      rawMessageId
    },
    session: {
      scope: "dm",
      sessionId
    },
    type: "message.text",
    payload: { kind: "text", text },
    meta: {
      receivedAt: "2026-05-24T00:00:00.000Z",
      replyTo: rawMessageId
    }
  };
}

function textOutput(sessionId: string, text: string): AgentOutput {
  return {
    id: "out_1",
    target: {
      plugin: "feishu",
      channelId: "chat",
      sessionId
    },
    content: { kind: "text", text },
    meta: {
      createdAt: "2026-05-24T00:00:00.000Z",
      urgency: "normal"
    }
  };
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
