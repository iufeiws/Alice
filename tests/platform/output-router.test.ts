import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutputRouter } from "../../src/platform/output-router/src/index.js";

test("OutputRouter notifies listeners only after a message is sent successfully", async () => {
  const router = createOutputRouter<{ target: { plugin: string }; text: string }, string>();
  const events: string[] = [];
  router.register({
    id: "feishu",
    async send(output) {
      events.push(`send:${output.text}`);
      if (output.text === "failed") throw new Error("send failed");
      return "sent";
    }
  });
  router.onSent((output) => {
    events.push(`sent:${output.text}`);
  });

  assert.equal(await router.send({ target: { plugin: "feishu" }, text: "ok" }), "sent");
  await assert.rejects(router.send({ target: { plugin: "feishu" }, text: "failed" }), /send failed/);
  assert.deepEqual(events, ["send:ok", "sent:ok", "send:failed"]);
});
