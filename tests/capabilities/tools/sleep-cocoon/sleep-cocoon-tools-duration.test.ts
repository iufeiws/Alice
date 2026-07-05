import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSleepDurationMs } from "../../../../src/capabilities/tools/sleep-cocoon/src/index.js";

test("sleep_cocoon duration uses requested integer hours plus fifteen minute jitter", () => {
  assert.equal(resolveSleepDurationMs(8, () => 0), 7.75 * 60 * 60 * 1000);
  assert.equal(resolveSleepDurationMs(8, () => 1), 8.25 * 60 * 60 * 1000);
});

test("sleep_cocoon default duration is between six and eight hours", () => {
  assert.equal(resolveSleepDurationMs(undefined, () => 0), 6 * 60 * 60 * 1000);
  assert.equal(resolveSleepDurationMs(undefined, () => 1), 8 * 60 * 60 * 1000);
});
