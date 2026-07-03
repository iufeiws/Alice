import test from "node:test";
import assert from "node:assert/strict";
import { coreProfileFixture, emptyCoreProfile } from "./core-profile-helpers.js";

test("core profile store get returns a copy", () => {
  const { store } = coreProfileFixture("get-copy");
  const profile = store.get();

  profile.appearanceDescription = "mutated";

  assert.deepEqual(store.get(), emptyCoreProfile);
});

test("core profile store save returns a copy", () => {
  const { store } = coreProfileFixture("save-copy");
  const saved = store.save({
    appearanceDescription: "浅金色头发",
    librarySetting: "图书馆设定"
  });

  saved.librarySetting = "mutated";

  assert.deepEqual(store.get(), {
    appearanceDescription: "浅金色头发",
    librarySetting: "图书馆设定"
  });
});

