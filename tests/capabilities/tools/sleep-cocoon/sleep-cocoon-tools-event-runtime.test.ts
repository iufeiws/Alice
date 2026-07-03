import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createSleepCocoonEventRuntime } from "../../../../src/capabilities/tools/sleep-cocoon/src/index.js";

test("sleep cocoon goodnight event only runs from idle state", () => {
  const time = createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z"));
  let state = "waiting";
  let autoChecked = 0;
  const runtime = createSleepCocoonEventRuntime({
    agentState: {
      getSnapshot() {
        return {
          state,
          sleepCocoonEnteredAt: "2026-05-25T00:00:00.000"
        };
      },
      setState() {},
      canRunHeartbeat() {
        return true;
      },
      noteSleepCocoonAutoChecked() {
        autoChecked += 1;
      }
    },
    time,
    getDefaultTarget() {
      return { plugin: "feishu", sessionId: "session-1" };
    },
    random: () => 0
  });

  assert.equal(runtime.maybeBuildGoodnightEvent(), undefined);
  assert.equal(autoChecked, 0);

  state = "idle";
  const event = runtime.maybeBuildGoodnightEvent();

  assert.equal(event?.meta.raw.agentInitiatedTriggerEvent, "sleep_cocoon.auto_goodnight_check");
  assert.equal(autoChecked, 1);
});
