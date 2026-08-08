import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { createFeishuPlugin } from "../../../src/channels/feishu/src/index.js";
import { createFeishuPairingStore, type FeishuPairingStore } from "../../../src/channels/feishu/src/pairing.js";
import { createInMemoryFeishuBindingStore } from "../../../src/channels/feishu/src/bindings.js";
import { textMessageEventToAgentEvent } from "../../../src/channels/feishu/src/handlers/message.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import type { FeishuConfig, FeishuTextMessageEvent } from "../../../src/channels/feishu/src/types.js";
import { pairedStore, rawTextMessage, waitFor } from "./feishu-dedupe-helpers.js";

function multiAccountConfig(): FeishuConfig {
  return {
    enabled: true,
    connectionMode: "websocket",
    accounts: {
      main: { appId: "app_main", appSecret: "secret_main", name: "Agent" },
      work: { appId: "app_work", appSecret: "secret_work", name: "Work" }
    },
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

function textOutput(accountId: string, sessionId: string): AgentOutput {
  return {
    id: `out_${accountId}`,
    target: {
      plugin: "feishu",
      accountId,
      channelId: "oc_chat",
      userId: "ou_user",
      sessionId
    },
    content: {
      kind: "text",
      text: "hello"
    },
    meta: {
      createdAt: "2026-02-02T02:40:00.000Z",
      createdAtUtc: "2026-02-02T02:40:00.000Z",
      urgency: "normal"
    }
  };
}

function pairingEvent(accountId: string, userId: string, sessionId = `feishu:dm:${userId}`): AgentEvent {
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
      sessionId
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

test("feishu text normalization carries the account id", async () => {
  const event = await textMessageEventToAgentEvent(rawTextMessage("om_acc", "hello"), createInMemoryFeishuBindingStore(), "work");
  assert.equal(event.source.accountId, "work");
  assert.equal(event.source.plugin, "feishu");
});

test("feishu plugin ingest routes to the given account and the default follows the pointer", async () => {
  const handled: Array<AgentEvent | undefined> = [];
  const plugin = createFeishuPlugin(multiAccountConfig(), {
    async onEvent(event) {
      handled.push(event);
    },
    pairingStore: pairedStore()
  });

  await plugin.ingestTextMessage(rawTextMessage("om_default", "hello"));
  await plugin.ingestTextMessage(rawTextMessage("om_work", "hello"), "work");
  await plugin.ingestTextMessage(rawTextMessage("om_pointer_default", "hello"));

  await waitFor(() => handled.length === 3);
  assert.deepEqual(handled.map((event) => event?.source.accountId), ["main", "work", "work"], "default ingest follows the active account pointer");
});

test("feishu pairing is isolated per account", () => {
  const store = memoryPairingStore();

  const mainPair = store.pairFromEvent(pairingEvent("main", "ou_alice"));
  assert.equal(mainPair.ok, true);

  const workPair = store.pairFromEvent(pairingEvent("work", "ou_bob"));
  assert.equal(workPair.ok, true, "different account must not be blocked by another account's pairing");

  const mainRejected = store.pairFromEvent(pairingEvent("main", "ou_carol"));
  assert.equal(mainRejected.ok, false);
  assert.equal(mainRejected.ok === false && mainRejected.reason, "already_bound");

  assert.equal(store.isPaired(pairingEvent("main", "ou_alice")), true);
  assert.equal(store.isPaired(pairingEvent("work", "ou_bob")), true);
  assert.equal(store.isPaired(pairingEvent("main", "ou_bob")), false, "same user on another account must not count as paired");

  assert.equal(store.getPaired("main")?.userId, "ou_alice");
  assert.equal(store.getPaired("work")?.userId, "ou_bob");
  assert.equal(store.list().length, 2);
});

test("feishu plugin routes outbound to a configured account and rejects unknown accounts", async () => {
  const warnings: string[] = [];
  const plugin = createFeishuPlugin(multiAccountConfig(), {
    async onEvent() {},
    log(level, message) {
      if (level === "warn") warnings.push(message);
    }
  });

  await assert.rejects(
    plugin.send(textOutput("ghost", "feishu:dm:ghost")),
    /not configured/,
    "unknown account must fail explicitly instead of falling back"
  );

  await assert.rejects(
    plugin.send(textOutput("work", "feishu:dm:work")),
    /not started/,
    "configured account must route to its own monitor and fail only because the client is not started"
  );
});

test("feishu plugin exposes per-account status for configured accounts", () => {
  const plugin = createFeishuPlugin(multiAccountConfig(), {
    async onEvent() {}
  });
  assert.deepEqual(plugin.getAccountStatuses(), [
    { accountId: "main", configured: true, started: false },
    { accountId: "work", configured: true, started: false }
  ]);
});

test("feishu plugin tracks the active account from inbound messages", async () => {
  const config = multiAccountConfig();
  const changed: string[] = [];
  const plugin = createFeishuPlugin(config, {
    async onEvent() {},
    pairingStore: pairedStore(),
    onActiveAccountChanged: (accountId) => {
      changed.push(accountId);
    }
  });

  await plugin.ingestTextMessage(rawTextMessage("om_active", "hello"), "work");
  await waitFor(() => changed.length === 1);

  assert.deepEqual(changed, ["work"], "active account change must be reported once");
  assert.equal(config.activeAccount, "work");
  assert.equal(plugin.getDefaultAccountId(), "work", "default account must follow the active account pointer");
});

test("feishu plugin default account prefers the active account pointer", () => {
  const config = multiAccountConfig();
  config.activeAccount = "work";
  const plugin = createFeishuPlugin(config, {
    async onEvent() {}
  });
  assert.equal(plugin.getDefaultAccountId(), "work");

  config.activeAccount = "removed";
  assert.equal(plugin.getDefaultAccountId(), "main", "invalid active account must fall back to main");
});

test("feishu plugin default account falls back to main when pointer is empty", () => {
  const plugin = createFeishuPlugin(multiAccountConfig(), {
    async onEvent() {}
  });
  assert.equal(plugin.getDefaultAccountId(), "main");
});

test("feishu raw message helper carries a valid shape", () => {
  const raw: FeishuTextMessageEvent = rawTextMessage("om_shape", "hello");
  assert.equal(raw.event.message.message_id, "om_shape");
  assert.equal(raw.event.message.chat_type, "p2p");
});
