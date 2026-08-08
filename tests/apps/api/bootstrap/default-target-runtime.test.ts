import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultTargetResolver } from "../../../../src/apps/api/bootstrap/default-target-runtime.js";
import { createFeishuPairingStore, type FeishuPairingStore } from "../../../../src/channels/feishu/src/pairing.js";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import type { AgentEvent } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

function pairingEvent(accountId: string, userId: string): AgentEvent {
  return {
    id: `evt_${accountId}_${userId}`,
    source: {
      plugin: "feishu",
      accountId,
      channelId: `oc_${accountId}`,
      userId,
      rawMessageId: `om_${accountId}_${userId}`
    },
    externalSession: {
      scope: "dm",
      sessionId: `feishu:dm:oc_${accountId}`
    },
    type: "message.text",
    payload: { kind: "text", text: "/pair alice" },
    meta: { receivedAt: "2026-02-02T02:40:00.000Z" }
  };
}

function memoryPairingStore(): FeishuPairingStore {
  let file: string | undefined;
  return createFeishuPairingStore("memory", {
    read() {
      return file;
    },
    write(_path, content) {
      file = content;
    }
  }, { time: createCurrentTimeProvider("UTC", () => new Date("2026-02-02T02:40:00.000Z")) });
}

function resolver(config: any, store: FeishuPairingStore) {
  return createDefaultTargetResolver({
    config,
    feishuPairingStore: store,
    wechatStateStore: { getDefaultTarget: () => undefined }
  });
}

test("default feishu target follows the active account pointer when that account has a paired contact", () => {
  const store = memoryPairingStore();
  store.pairFromEvent(pairingEvent("main", "ou_alice"));
  store.pairFromEvent(pairingEvent("work", "ou_bob"));
  const target = resolver({
    core: {},
    plugins: { wechat: { enabled: false }, feishu: { activeAccount: "work" } }
  }, store).getDefaultFeishuTarget();
  assert.equal(target?.accountId, "work");
  assert.equal(target?.sessionId, "feishu:dm:oc_work");
});

test("default feishu target falls back to the first paired contact when the pointer is missing", () => {
  const store = memoryPairingStore();
  store.pairFromEvent(pairingEvent("main", "ou_alice"));
  store.pairFromEvent(pairingEvent("work", "ou_bob"));
  const target = resolver({
    core: {},
    plugins: { wechat: { enabled: false }, feishu: {} }
  }, store).getDefaultFeishuTarget();
  assert.equal(target?.accountId, "main");
  assert.equal(target?.sessionId, "feishu:dm:oc_main");
});

test("default feishu target falls back to the first paired contact when the pointer account has no contact", () => {
  const store = memoryPairingStore();
  store.pairFromEvent(pairingEvent("main", "ou_alice"));
  const target = resolver({
    core: {},
    plugins: { wechat: { enabled: false }, feishu: { activeAccount: "ghost" } }
  }, store).getDefaultFeishuTarget();
  assert.equal(target?.accountId, "main");
  assert.equal(target?.sessionId, "feishu:dm:oc_main");
});
