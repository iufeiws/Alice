import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeishuPlugin } from "../../../src/channels/feishu/src/index.js";
import { feishuConfig, pairedStore, rawTextMessage, textOutput } from "./feishu-dedupe-helpers.js";

type ReactionCall = { action: "add" | "remove"; messageId: string; emojiType?: string; reactionId?: string };

test("feishu plugin starts and stops typing on the latest inbound message", async () => {
  const reactions: ReactionCall[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {},
    pairingStore: pairedStore(),
    reactionClient: reactionClient(reactions, () => "reaction-1")
  });

  await plugin.ingestTextMessage(rawTextMessage("om_typing", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: false });

  assert.equal(count(reactions, "add"), 1);
  assert.ok(hasReaction(reactions, { action: "add", messageId: "om_typing", emojiType: "Coffee" }));
  assert.ok(hasReaction(reactions, { action: "remove", messageId: "om_typing", reactionId: "reaction-1" }));
});

test("feishu plugin moves typing reaction when latest outbound message changes", async () => {
  let nextReaction = 1;
  const reactions: ReactionCall[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {},
    pairingStore: pairedStore(),
    outbound: {
      async send() {
        return { messageId: "om_outbound" };
      }
    },
    reactionClient: reactionClient(reactions, () => `reaction-${nextReaction++}`)
  });

  await plugin.ingestTextMessage(rawTextMessage("om_inbound", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.send(textOutput("feishu:dm:oc_chat", "ok"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });

  assert.ok(hasReaction(reactions, { action: "add", messageId: "om_inbound", emojiType: "Coffee" }));
  assert.ok(hasReaction(reactions, { action: "remove", messageId: "om_inbound", reactionId: "reaction-1" }));
  assert.ok(hasReaction(reactions, { action: "add", messageId: "om_outbound", emojiType: "Coffee" }));
});

test("feishu plugin clears active typing reactions on stop", async () => {
  const reactions: ReactionCall[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent() {},
    pairingStore: pairedStore(),
    reactionClient: reactionClient(reactions, () => "reaction-stop")
  });

  await plugin.ingestTextMessage(rawTextMessage("om_stop", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });
  await plugin.stop();

  assert.ok(hasReaction(reactions, { action: "add", messageId: "om_stop", emojiType: "Coffee" }));
  assert.ok(hasReaction(reactions, { action: "remove", messageId: "om_stop", reactionId: "reaction-stop" }));
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
  assert.equal(warnings.length, 2);
});

test("feishu plugin warns when typing starts without a recent message", async () => {
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

  assert.equal(warnings.length > 0, true);
});

test("feishu plugin warns when typing reaction start fails", async () => {
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

  await plugin.ingestTextMessage(rawTextMessage("om_warn", "hello"));
  await plugin.setTyping({ sessionId: "feishu:dm:oc_chat", typing: true });

  assert.equal(warnings.length > 0, true);
});

function reactionClient(reactions: ReactionCall[], reactionId: () => string) {
  return {
    async addReaction(input: { messageId: string; emojiType: string }) {
      const id = reactionId();
      reactions.push({ action: "add", ...input });
      return { reactionId: id };
    },
    async removeReaction(input: { messageId: string; reactionId: string }) {
      reactions.push({ action: "remove", ...input });
    }
  };
}

function hasReaction(reactions: ReactionCall[], expected: ReactionCall): boolean {
  return reactions.some((reaction) => {
    return Object.entries(expected).every(([key, value]) => reaction[key as keyof ReactionCall] === value);
  });
}

function count(reactions: ReactionCall[], action: ReactionCall["action"]): number {
  return reactions.filter((reaction) => reaction.action === action).length;
}
