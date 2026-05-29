import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoreProfileStore } from "../core/agent/src/core-profile.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

test("core profile stores appearance description", () => {
  const dir = path.join(os.tmpdir(), `alice-core-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "core-profile.json");
  const store = createCoreProfileStore(filePath);

  assert.deepEqual(store.get(), { appearanceDescription: "" });
  assert.deepEqual(store.save({ appearanceDescription: "浅金色头发" }), { appearanceDescription: "浅金色头发" });
  assert.deepEqual(createCoreProfileStore(filePath).get(), { appearanceDescription: "浅金色头发" });
});
