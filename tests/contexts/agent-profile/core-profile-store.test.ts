import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCoreProfileStore } from "../../../src/contexts/agent-profile/src/adapters/json-core-profile-store.js";
import { coreProfileFixture, emptyCoreProfile } from "./core-profile-helpers.js";

test("core profile store creates an empty persisted profile by default", () => {
  const { filePath, store } = coreProfileFixture("default");

  assert.deepEqual(store.get(), emptyCoreProfile);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), emptyCoreProfile);
});

test("core profile store saves complete profile and reloads it", () => {
  const { filePath, store } = coreProfileFixture("save");
  const profile = {
    appearanceDescription: "浅金色头发",
    librarySetting: "图书馆设定"
  };

  assert.deepEqual(store.save(profile), profile);
  assert.deepEqual(createCoreProfileStore(filePath).get(), profile);
});

test("core profile store partial save preserves existing fields", () => {
  const { store } = coreProfileFixture("partial-save");

  store.save({
    appearanceDescription: "浅金色头发",
    librarySetting: "旧图书馆设定"
  });

  assert.deepEqual(store.save({ librarySetting: "新图书馆设定" }), {
    appearanceDescription: "浅金色头发",
    librarySetting: "新图书馆设定"
  });
});

