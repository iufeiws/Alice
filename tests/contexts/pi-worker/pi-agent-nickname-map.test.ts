import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiAgentNicknameMap, readPiAgentNames } from "../../../src/contexts/pi-worker/runtime/pi-agent-nickname-map.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

test("Pi agent name list contains the gist's 1025 names with spaces normalized", () => {
  const names = readPiAgentNames(path.resolve("src/contexts/pi-worker/runtime/pi-agent-names.txt"));
  assert.equal(names.length, 1025);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.includes("mr._mime"), true);
  assert.equal(names.includes("great_tusk"), true);
  assert.equal(names.some((name) => name.includes(" ")), false);
});

test("name loader replaces spaces before validating the list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-names-"));
  const filePath = path.join(root, "names.txt");
  fs.writeFileSync(filePath, "Alpha Name\nBeta  Name\n");

  assert.deepEqual(readPiAgentNames(filePath), ["Alpha_Name", "Beta__Name"]);
});

test("nickname map assigns an unused random name and persists the reverse mapping", () => {
  const filePath = temporaryMapPath();
  const map = createPiAgentNicknameMap({ filePath, names: ["alpha", "beta"], randomInt: () => 1 });

  assert.deepEqual(map.assign("session-1", 100), { nickname: "beta", sessionId: "session-1", createdAtMs: 100 });
  assert.deepEqual(map.resolve("beta"), { nickname: "beta", sessionId: "session-1", createdAtMs: 100 });

  const reopened = createPiAgentNicknameMap({ filePath, names: ["alpha", "beta"] });
  assert.deepEqual(reopened.entries(), [{ nickname: "beta", sessionId: "session-1", createdAtMs: 100 }]);
});

test("nickname map reclaims the oldest mapping when every name is occupied", () => {
  const filePath = temporaryMapPath();
  const map = createPiAgentNicknameMap({ filePath, names: ["alpha", "beta"], randomInt: () => 0 });

  map.assign("session-1", 100);
  map.assign("session-2", 200);
  assert.deepEqual(map.assign("session-3", 300), { nickname: "alpha", sessionId: "session-3", createdAtMs: 300 });
  assert.equal(map.entries().some((entry) => entry.sessionId === "session-1"), false);
  assert.deepEqual(map.resolve("alpha").sessionId, "session-3");
});

test("nickname map removes entries older than 30 days", () => {
  const filePath = temporaryMapPath();
  const map = createPiAgentNicknameMap({ filePath, names: ["alpha", "beta"], randomInt: () => 0 });
  map.assign("session-old", 100);
  map.assign("session-new", MONTH_MS + 100);

  assert.equal(map.pruneExpired(MONTH_MS + 101), 1);
  assert.deepEqual(map.entries(), [{ nickname: "beta", sessionId: "session-new", createdAtMs: MONTH_MS + 100 }]);
});

test("nickname map release removes only the matching session assignment", () => {
  const filePath = temporaryMapPath();
  const map = createPiAgentNicknameMap({ filePath, names: ["alpha"] });
  map.assign("session-1", 100);

  assert.equal(map.release("alpha", "session-other"), false);
  assert.equal(map.release("alpha", "session-1"), true);
  assert.deepEqual(map.entries(), []);
});

function temporaryMapPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-nickname-map-"));
  return path.join(root, "pi-agent-nicknames.json");
}
