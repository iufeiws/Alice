import { test } from "node:test";
import assert from "node:assert/strict";
import { createDailyShellStore } from "../../../src/contexts/agent-profile/src/domain/shell.js";
import { makeTempDir, replaceShellCategory } from "./prompt-profile-helpers.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("dailyShellStore_emptyRoot_createsCategoryFiles", () => {
  const root = makeTempDir("daily-shell");
  const store = createDailyShellStore(root);
  store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  const shellDir = path.join(root, "shell");

  assert.equal(fs.readdirSync(path.join(shellDir, "personalities")).filter((item) => item.endsWith(".json")).length >= 10, true);
  assert.equal(fs.readdirSync(path.join(shellDir, "relationships")).filter((item) => item.endsWith(".json")).length >= 10, true);
  assert.equal(fs.readdirSync(path.join(shellDir, "outfits")).filter((item) => item.endsWith(".json")).length >= 10, true);
});

test("dailyShellStore_sameDay_reusesDailyShell", () => {
  const root = makeTempDir("daily-shell-same-day");
  const store = createDailyShellStore(root);
  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  const second = store.get(new Date("2026-05-26T15:59:59.000Z"), "Asia/Shanghai");

  assert.equal(first.date, "2026-05-26");
  assert.equal(second.date, "2026-05-26");
  assert.equal(second.personality.id, first.personality.id);
  assert.equal(second.relationship.id, first.relationship.id);
  assert.equal(second.outfit.id, first.outfit.id);
});

test("dailyShellStore_emptyRoot_createsPromptTemplateInAgentProfileFolder", () => {
  const root = makeTempDir("daily-shell-template");
  createDailyShellStore(root).get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");

  assert.equal(fs.existsSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "shell-prompt-template.txt")), true);
  assert.equal(fs.existsSync(path.join(root, "shell", "prompt-template.txt")), false);
});

test("dailyShellStore_outfitImageUrls_preservesImageState", () => {
  const root = makeTempDir("daily-shell-image");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "outfits", [
    {
      id: "custom_outfit",
      name: "Custom Outfit",
      content: "custom content",
      group: "fantasy",
      imageUrl: "memory-files/shell/assets/custom.png",
      onBodyImageUrl: "memory-files/shell/assets/custom-on-body.png",
      outfitImageGenerated: true,
      onBodyGenerationAttempted: false
    }
  ]);

  const config = store.getConfig(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  assert.equal(config.outfits[0].imageUrl, "memory-files/shell/assets/custom.png");
  assert.equal(config.outfits[0].onBodyImageUrl, "memory-files/shell/assets/custom-on-body.png");
  assert.equal(config.outfits[0].outfitImageGenerated, true);
});

test("dailyShellStore_generatedOutfitImage_marksOnBodyAttempted", () => {
  const root = makeTempDir("daily-shell-generated-attempted");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "outfits", [
    {
      id: "generated_outfit",
      name: "Generated Outfit",
      content: "generated content",
      imageUrl: "memory-files/shell/assets/generated.png",
      outfitImageGenerated: true
    }
  ]);

  const config = store.getConfig(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");

  assert.equal(config.outfits[0].outfitImageGenerated, true);
  assert.equal(config.outfits[0].onBodyGenerationAttempted, true);
});

test("dailyShellPromptTemplate_savedTemplate_persistsConfig", () => {
  const root = makeTempDir("daily-shell-prompt");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [
    { id: "p2", name: "P Two", content: "personality two" },
    { id: "p1", name: "P One", content: "personality one" }
  ]);
  store.savePromptTemplate("P={{personality_name}}\nR={{relationship_name}}\nO={{outfit_name}}");

  const config = store.getConfig(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  assert.equal(config.promptTemplate, "P={{personality_name}}\nR={{relationship_name}}\nO={{outfit_name}}");
  assert.equal(fs.readFileSync(path.join(root, "src", "contexts", "agent-profile", "prompts", "shell-prompt-template.txt"), "utf8"), "P={{personality_name}}\nR={{relationship_name}}\nO={{outfit_name}}\n");
});

test("dailyShellStore_activeOptionEdited_keepsSameDailyShell", () => {
  const root = makeTempDir("daily-shell-stable");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [
    { id: "p1", name: "P One", content: "personality one" }
  ]);
  replaceShellCategory(root, store, "relationships", [
    { id: "r1", name: "R One", content: "relationship one" }
  ]);
  replaceShellCategory(root, store, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" }
  ]);

  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  store.saveOption("personalities", { id: "p2", name: "P Two", content: "personality two" }, "p1");
  const second = store.get(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai");

  assert.equal(first.relationship.id, second.relationship.id);
  assert.equal(first.outfit.id, second.outfit.id);
  assert.equal(second.personality.id, "p2");
});

test("dailyShellStore_activeOptionFileChanged_refreshesDailyShell", () => {
  const root = makeTempDir("daily-shell-refresh");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [
    { id: "p1", name: "P One", content: "personality one" }
  ]);
  replaceShellCategory(root, store, "relationships", [
    { id: "r1", name: "R One", content: "relationship one" }
  ]);
  replaceShellCategory(root, store, "outfits", [
    { id: "o1", name: "O One", content: "outfit one", imageUrl: "memory-files/shell/outfits/o1.jpg" }
  ]);

  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  const updated = {
    ...first.outfit,
    onBodyImageUrl: "memory-files/shell/outfits/o1.On_Body_Ref.jpg"
  };
  fs.writeFileSync(path.join(root, "shell", "outfits", "o1.json"), `${JSON.stringify(updated, null, 2)}\n`);

  const second = store.get(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai");

  assert.equal(second.outfit.id, "o1");
  assert.equal(second.outfit.onBodyImageUrl, "memory-files/shell/outfits/o1.On_Body_Ref.jpg");
});

test("dailyShellStore_switchOutfit_updatesOnlyActiveOutfit", () => {
  const root = makeTempDir("daily-shell-switch-outfit");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [
    { id: "o1", name: "O One", content: "outfit one" },
    { id: "o2", name: "O Two", content: "outfit two" }
  ]);

  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  const switched = store.switchOutfit(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai", "o2");

  assert.equal(switched.personality.id, first.personality.id);
  assert.equal(switched.relationship.id, first.relationship.id);
  assert.equal(switched.outfit.id, "o2");
  assert.equal(switched.date, first.date);
  assert.equal(switched.createdAt, first.createdAt);
});

test("dailyShellStore_switchOutfit_rejectsUnknownOutfit", () => {
  const root = makeTempDir("daily-shell-switch-missing");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [{ id: "o1", name: "O One", content: "outfit one" }]);

  store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");

  assert.throws(() => store.switchOutfit(new Date("2026-05-26T14:00:00.000Z"), "Asia/Shanghai", "missing"), /unknown_outfit/);
});

test("dailyShellStore_rolloverBeforeWake_keepsShellUntilReroll", () => {
  const root = makeTempDir("daily-shell-wake-reroll");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "R One", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [{ id: "o1", name: "O One", content: "outfit one" }]);
  const first = store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  const before = store.get(new Date("2026-05-26T19:59:00.000Z"), "Asia/Shanghai");
  const after = store.get(new Date("2026-05-26T20:00:00.000Z"), "Asia/Shanghai");
  const woke = store.reroll(new Date("2026-05-26T20:01:00.000Z"), "Asia/Shanghai");

  assert.equal(first.date, "2026-05-26");
  assert.equal(before.createdAt, first.createdAt);
  assert.equal(after.createdAt, first.createdAt);
  assert.equal(woke.date, "2026-05-27");
  assert.notEqual(woke.createdAt, first.createdAt);
});

test("dailyShellStore_recentRelationships_avoidsRecentlyUsedIdentities", () => {
  const root = makeTempDir("daily-shell-recent-relationships");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "P One", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [
    { id: "r1", name: "A One", content: "relationship one" },
    { id: "r2", name: "B Two", content: "relationship two" },
    { id: "r3", name: "C Three", content: "relationship three" }
  ]);
  replaceShellCategory(root, store, "outfits", [{ id: "o1", name: "O One", content: "outfit one" }]);

  const originalRandom = Math.random;
  const randomValues = [
    0, 0, 0,
    0.9, 0, 0,
    0.9, 0, 0,
    0.9, 0, 0
  ];
  Math.random = () => randomValues.shift() ?? 0;
  try {
    const first = store.reroll(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
    const reopened = createDailyShellStore(root);
    const second = reopened.reroll(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai");
    const third = reopened.reroll(new Date("2026-05-26T14:00:00.000Z"), "Asia/Shanghai");
    const fourth = reopened.reroll(new Date("2026-05-26T15:00:00.000Z"), "Asia/Shanghai");

    assert.deepEqual(
      [first.relationship.id, second.relationship.id, third.relationship.id, fourth.relationship.id],
      ["r1", "r3", "r2", "r3"]
    );
  } finally {
    Math.random = originalRandom;
  }
});

test("dailyShellStore_shellSwitch_recordsLocalTimeLogs", () => {
  const root = makeTempDir("daily-shell-switch-log");
  const store = createDailyShellStore(root);
  replaceShellCategory(root, store, "personalities", [{ id: "p1", name: "冷淡", content: "personality one" }]);
  replaceShellCategory(root, store, "relationships", [{ id: "r1", name: "同桌", content: "relationship one" }]);
  replaceShellCategory(root, store, "outfits", [{ id: "o1", name: "制服", content: "outfit one" }]);
  store.get(new Date("2026-05-26T12:00:00.000Z"), "Asia/Shanghai");
  store.get(new Date("2026-05-26T13:00:00.000Z"), "Asia/Shanghai");
  store.get(new Date("2026-05-26T20:00:00.000Z"), "Asia/Shanghai");
  store.reroll(new Date("2026-05-26T20:00:00.000Z"), "Asia/Shanghai");

  const logs = store.listSwitchLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].time, "2026-05-26T20:00:00.000");
  assert.equal(logs[1].time, "2026-05-27T04:00:00.000");
  assert.doesNotMatch(logs[0].time, /Z$|[+-]\d{2}:\d{2}$/);
  assert.doesNotMatch(logs[1].time, /Z$|[+-]\d{2}:\d{2}$/);
});
