import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutputRouter } from "../../src/platform/output-router/src/index.js";
import { createAgentStateController } from "../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { memoryStore } from "../contexts/agent-loop/agent-state-helpers.js";

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

test("successful outbound messages restart inactivity while failed sends do not", async () => {
  let current = new Date("2026-05-25T00:00:00.000Z");
  const controller = createAgentStateController({
    store: memoryStore(),
    now: () => current,
    random: () => 0
  });
  controller.suspendInactivityTimer();

  const router = createOutputRouter<{ target: { plugin: string }; text: string }, string>();
  router.register({
    id: "feishu",
    async send(output) {
      if (output.text === "failed") throw new Error("send failed");
      return "sent";
    }
  });
  router.onSent(() => {
    controller.restartInactivityTimer();
  });

  current = new Date("2026-05-25T01:00:00.000Z");
  assert.equal(await router.send({ target: { plugin: "feishu" }, text: "ok" }), "sent");
  const restartedDeadline = controller.getSnapshot().nextTransitionAt;
  assert.notEqual(restartedDeadline, undefined);

  current = new Date("2026-05-25T02:00:00.000Z");
  await assert.rejects(router.send({ target: { plugin: "feishu" }, text: "failed" }), /send failed/);
  assert.equal(controller.getSnapshot().nextTransitionAt, restartedDeadline);
});
