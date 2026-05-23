import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecentMessageDeduper } from "../plugins/feishu/src/dedupe.js";
import { createFeishuPlugin } from "../plugins/feishu/src/index.js";
import type { FeishuTextMessageEvent } from "../plugins/feishu/src/types.js";
import type { FeishuConfig } from "../packages/config/src/index.js";

test("recent message deduper rejects repeated keys inside ttl", () => {
  const deduper = createRecentMessageDeduper({ ttlMs: 1000 });
  assert.equal(deduper.remember("om_1", 1000), true);
  assert.equal(deduper.remember("om_1", 1100), false);
  assert.equal(deduper.remember("om_1", 2101), true);
});

test("feishu plugin ignores duplicate message ids before agent handling", async () => {
  let handled = 0;
  const warnings: string[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {
      handled += 1;
    },
    log(level, message) {
      if (level === "warn") warnings.push(message);
    },
    pairingStore: {
      list: () => [{
        id: "feishu:dm:ou_user",
        plugin: "feishu",
        userId: "ou_user",
        channelId: "oc_chat",
        sessionId: "feishu:dm:ou_user",
        scope: "dm",
        pairedAt: "2026-05-24T00:00:00.000Z",
        lastSeenAt: "2026-05-24T00:00:00.000Z",
        canInitiate: true
      }],
      isPaired: () => true,
      pairFromEvent: () => {
        throw new Error("not expected");
      }
    }
  });

  const raw = rawTextMessage("om_same", "hello");
  await plugin.ingestTextMessage(raw);
  await plugin.ingestTextMessage(raw);
  await waitFor(() => handled === 1);

  assert.equal(handled, 1);
  assert.ok(warnings.some((message) => message.includes("duplicate message ignored: om_same")));
});

test("feishu plugin returns before slow agent handling completes", async () => {
  let releaseAgent!: () => void;
  let handled = false;
  const agentBlocked = new Promise<void>((resolve) => {
    releaseAgent = resolve;
  });
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {
      await agentBlocked;
      handled = true;
    },
    pairingStore: pairedStore()
  });

  await plugin.ingestTextMessage(rawTextMessage("om_slow", "hello"));
  assert.equal(handled, false);

  releaseAgent();
  await waitFor(() => handled);
  assert.equal(handled, true);
});

function feishuConfig(): FeishuConfig {
  return {
    enabled: true,
    connectionMode: "websocket",
    accounts: { main: { appId: "app", appSecret: "secret" } },
    dmPolicy: "pairing",
    dmAllowFrom: [],
    groupPolicy: "allowlist",
    groupAllowFrom: [],
    requireMention: true,
    codexPolicy: {
      enabled: true,
      requireAllowlist: true,
      allowedUsers: [],
      allowedChats: [],
      requireExplicitCommand: true
    }
  };
}

function rawTextMessage(messageId: string, text: string): FeishuTextMessageEvent {
  return {
    header: {
      event_id: `evt_${messageId}`,
      create_time: "1770000000000"
    },
    event: {
      message: {
        message_id: messageId,
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: JSON.stringify({ text })
      },
      sender: {
        sender_id: {
          open_id: "ou_user"
        }
      }
    }
  };
}

function pairedStore() {
  return {
    list: () => [{
      id: "feishu:dm:ou_user",
      plugin: "feishu" as const,
      userId: "ou_user",
      channelId: "oc_chat",
      sessionId: "feishu:dm:ou_user",
      scope: "dm" as const,
      pairedAt: "2026-05-24T00:00:00.000Z",
      lastSeenAt: "2026-05-24T00:00:00.000Z",
      canInitiate: true
    }],
    isPaired: () => true,
    pairFromEvent: () => {
      throw new Error("not expected");
    }
  };
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
