import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeishuPlugin } from "../../../src/channels/feishu/src/index.js";
import { feishuConfig, pairedStore, rawTextMessage, waitFor } from "./feishu-dedupe-helpers.js";

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
    pairingStore: pairedStore()
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
