import { test } from "node:test";
import assert from "node:assert/strict";
import { delayUntilNext } from "../../../src/platform/scheduler/src/index.js";

test("delayUntilNext returns same-day delay before target time", () => {
  assert.equal(delayUntilNext(4, 0, new Date(2026, 4, 29, 3, 0, 0, 0)), 60 * 60 * 1000);
});

test("delayUntilNext returns next-day delay after target time", () => {
  assert.equal(delayUntilNext(4, 0, new Date(2026, 4, 29, 5, 0, 0, 0)), 23 * 60 * 60 * 1000);
});
