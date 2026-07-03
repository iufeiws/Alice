import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecentMessageDeduper } from "../../../src/channels/feishu/src/dedupe.js";

test("recent message deduper rejects repeated keys inside ttl", () => {
  const deduper = createRecentMessageDeduper({ ttlMs: 1000 });
  assert.equal(deduper.remember("om_1", 1000), true);
  assert.equal(deduper.remember("om_1", 1100), false);
  assert.equal(deduper.remember("om_1", 2101), true);
});
