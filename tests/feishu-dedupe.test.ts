import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecentMessageDeduper } from "../src/plugins/feishu/src/dedupe.js";
import { createFeishuPlugin } from "../src/plugins/feishu/src/index.js";
import type { FeishuAudioMessageEvent, FeishuTextMessageEvent } from "../src/plugins/feishu/src/types.js";
import type { FeishuConfig } from "../src/packages/config/src/index.js";
import type { AgentEvent, AgentOutput } from "../src/packages/types/src/index.js";

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

test("feishu plugin prepares inbound audio with transcript for message runtime", async () => {
  const handled: AgentEvent[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent(event) {
      handled.push(event);
    },
    pairingStore: pairedStore(),
    async storeAudioAsset(input) {
      assert.equal(input.fileKey, "file_v2_1");
      assert.equal(input.messageId, "om_audio");
      return {
        assetId: "plugin/feishu/audio/om_audio.opus",
        filePath: "assets/plugin/feishu/audio/om_audio.opus",
        filename: "om_audio.opus",
        mimeType: "audio/opus"
      };
    },
    asr: {
      async transcribe(input) {
        assert.equal(input.audioFile, "assets/plugin/feishu/audio/om_audio.opus");
        assert.equal(input.filename, "om_audio.opus");
        assert.equal(input.mimeType, "audio/opus");
        assert.deepEqual(input.metadata, {
          plugin: "feishu",
          messageId: "om_audio",
          chatId: "oc_chat"
        });
        return { text: "[语音][0:0.020,0:5.000]  今晚十点提醒我睡觉", provider: "openai_compatible" };
      }
    }
  });

  await plugin.ingestAudioMessage(rawAudioMessage("om_audio"));
  await waitFor(() => handled.length === 1);

  const event = handled[0];
  assert.equal(event.type, "message.audio");
  assert.equal(event.payload.kind, "audio");
  assert.equal(event.payload.assetId, "plugin/feishu/audio/om_audio.opus");
  assert.equal(event.payload.transcript, "今晚十点提醒我睡觉");
  assert.equal(event.source.plugin, "feishu");
  assert.equal(event.source.rawMessageId, "om_audio");
  assert.equal(event.session.scope, "dm");
  assert.equal(event.session.sessionId, "feishu:dm:oc_chat");
  assert.equal(event.meta.replyTo, "om_audio");
  assert.equal(event.meta.receivedAtUtc, "2026-02-02T02:40:00.000Z");
});

test("feishu plugin does not forward inbound audio when asr returns no transcript", async () => {
  let handled = 0;
  const warnings: string[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {
      handled += 1;
    },
    log(level, message) {
      if (level === "warn") warnings.push(message);
    },
    pairingStore: pairedStore(),
    async storeAudioAsset() {
      return {
        assetId: "plugin/feishu/audio/om_empty.opus",
        filePath: "assets/plugin/feishu/audio/om_empty.opus",
        filename: "om_empty.opus",
        mimeType: "audio/opus"
      };
    },
    asr: {
      async transcribe() {
        return { ok: false, error: "empty_transcription", provider: "openai_compatible" };
      }
    }
  });

  await plugin.ingestAudioMessage(rawAudioMessage("om_empty"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(handled, 0);
  assert.ok(warnings.some((message) => message.includes("ignored audio om_empty: asr empty_transcription")));
});

test("feishu plugin starts and stops typing on the latest inbound message", async () => {
  const reactions: Array<{ action: "add" | "remove"; messageId: string; emojiType?: string; reactionId?: string }> = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {},
    pairingStore: pairedStore(),
    reactionClient: {
      async addReaction(input) {
        reactions.push({ action: "add", ...input });
        return { reactionId: "reaction-1" };
      },
      async removeReaction(input) {
        reactions.push({ action: "remove", ...input });
      }
    }
  });

  await plugin.ingestTextMessage(rawTextMessage("om_typing", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: false });

  assert.deepEqual(reactions, [
    { action: "add", messageId: "om_typing", emojiType: "Coffee" },
    { action: "remove", messageId: "om_typing", reactionId: "reaction-1" }
  ]);
});

test("feishu plugin moves typing reaction when latest outbound message changes", async () => {
  let nextReaction = 1;
  const reactions: Array<{ action: "add" | "remove"; messageId: string; emojiType?: string; reactionId?: string }> = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {},
    pairingStore: pairedStore(),
    outbound: {
      async send() {
        return { messageId: "om_outbound" };
      }
    },
    reactionClient: {
      async addReaction(input) {
        const reactionId = `reaction-${nextReaction++}`;
        reactions.push({ action: "add", ...input });
        return { reactionId };
      },
      async removeReaction(input) {
        reactions.push({ action: "remove", ...input });
      }
    }
  });

  await plugin.ingestTextMessage(rawTextMessage("om_inbound", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.send(textOutput("feishu:dm:oc_chat", "ok"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });

  assert.deepEqual(reactions, [
    { action: "add", messageId: "om_inbound", emojiType: "Coffee" },
    { action: "remove", messageId: "om_inbound", reactionId: "reaction-1" },
    { action: "add", messageId: "om_outbound", emojiType: "Coffee" }
  ]);
});

test("feishu plugin clears active typing reactions on stop", async () => {
  const reactions: Array<{ action: "add" | "remove"; messageId: string; emojiType?: string; reactionId?: string }> = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {},
    pairingStore: pairedStore(),
    reactionClient: {
      async addReaction(input) {
        reactions.push({ action: "add", ...input });
        return { reactionId: "reaction-stop" };
      },
      async removeReaction(input) {
        reactions.push({ action: "remove", ...input });
      }
    }
  });

  await plugin.ingestTextMessage(rawTextMessage("om_stop", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.stop();

  assert.deepEqual(reactions, [
    { action: "add", messageId: "om_stop", emojiType: "Coffee" },
    { action: "remove", messageId: "om_stop", reactionId: "reaction-stop" }
  ]);
});

test("feishu plugin retries typing reaction removal", async () => {
  let removeAttempts = 0;
  const warnings: string[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {},
    pairingStore: pairedStore(),
    log(level, message) {
      if (level === "warn") warnings.push(message);
    },
    reactionClient: {
      async addReaction() {
        return { reactionId: "reaction-retry" };
      },
      async removeReaction() {
        removeAttempts += 1;
        if (removeAttempts < 3) throw new Error(`temporary failure ${removeAttempts}`);
      }
    }
  });

  await plugin.ingestTextMessage(rawTextMessage("om_retry", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: false });

  assert.equal(removeAttempts, 3);
  assert.equal(warnings.filter((message) => message.includes("typing stop retry")).length, 2);
  assert.equal(warnings.some((message) => message.includes("typing stop failed")), false);
});

test("feishu plugin typing failures warn without throwing", async () => {
  const warnings: string[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {},
    pairingStore: pairedStore(),
    log(level, message) {
      if (level === "warn") warnings.push(message);
    },
    reactionClient: {
      async addReaction() {
        throw new Error("invalid reaction type");
      },
      async removeReaction() {
        throw new Error("not expected");
      }
    }
  });

  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.ingestTextMessage(rawTextMessage("om_warn", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });

  assert.ok(warnings.some((message) => message.includes("typing ignored: missing recent message")));
  assert.ok(warnings.some((message) => message.includes("typing start failed: invalid reaction type")));
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

function rawAudioMessage(messageId: string): FeishuAudioMessageEvent {
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
        message_type: "audio",
        content: JSON.stringify({ file_key: "file_v2_1", duration: 3000 })
      },
      sender: {
        sender_id: {
          open_id: "ou_user"
        }
      }
    }
  };
}

function textOutput(sessionId: string, text: string): AgentOutput {
  return {
    id: `out_${sessionId}`,
    target: {
      plugin: "feishu",
      accountId: "main",
      channelId: "oc_chat",
      userId: "ou_user",
      sessionId
    },
    content: {
      kind: "text",
      text
    },
    meta: {
      createdAt: "2026-02-02T02:40:00.000Z",
      createdAtUtc: "2026-02-02T02:40:00.000Z",
      urgency: "normal"
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
