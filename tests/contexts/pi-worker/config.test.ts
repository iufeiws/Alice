import test from "node:test";
import assert from "node:assert/strict";
import { defaultPiWorkerConfig, validatePiWorkerConfig } from "../../../src/contexts/pi-worker/src/config.js";

test("Pi worker defaults task timeout to six hours", () => {
  assert.equal(defaultPiWorkerConfig.taskTimeoutSeconds, 21_600);
  assert.equal(validatePiWorkerConfig({}).taskTimeoutSeconds, 21_600);
});
