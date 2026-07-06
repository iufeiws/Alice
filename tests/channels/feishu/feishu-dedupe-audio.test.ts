import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeishuPlugin } from "../../../src/channels/feishu/src/index.js";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { feishuConfig, pairedStore, rawAudioMessage, waitFor } from "./feishu-dedupe-helpers.js";

test("feishu plugin prepares inbound audio with transcript for message runtime", async () => {
  let storedMessageId = "";
  const handled: AgentEvent[] = [];
  const plugin = createFeishuPlugin(feishuConfig(), {
    async onEvent(event) {
      handled.push(event);
    },
    pairingStore: pairedStore(),
    async storeAudioAsset(input) {
      storedMessageId = input.messageId;
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
        return { text: "[语音][0:0.020,0:5.000]  今晚十点提醒我睡觉", provider: "openai_compatible" };
      }
    }
  });

  await plugin.ingestAudioMessage(rawAudioMessage("om_audio"));
  await waitFor(() => handled.length === 1);

  assert.equal(storedMessageId, "om_audio");
  const event = handled[0];
  assert.equal(event.type, "message.audio");
  assert.equal(event.payload.kind, "audio");
  assert.equal(event.payload.transcript, "今晚十点提醒我睡觉");
  assert.equal(event.meta.replyTo, "om_audio");
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
  await waitFor(() => warnings.length > 0);

  assert.equal(handled, 0);
});
