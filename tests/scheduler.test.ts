import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupPreviousTtsFiles, createDailyMaintenanceTasks, delayUntilNext } from "../core/scheduler/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("delayUntilNext returns next same-day or next-day delay", () => {
  assert.equal(delayUntilNext(4, 0, new Date(2026, 4, 29, 3, 0, 0, 0)), 60 * 60 * 1000);
  assert.equal(delayUntilNext(4, 0, new Date(2026, 4, 29, 5, 0, 0, 0)), 23 * 60 * 60 * 1000);
});

test("daily maintenance tasks clean logs and generated tts files", () => {
  const root = makeAssetTempDir("scheduler-maintenance");
  fs.writeFileSync(path.join(root, "20260528_235959_999.opus"), "old");
  fs.writeFileSync(path.join(root, "20260529_000000_000.opus"), "today");
  fs.writeFileSync(path.join(root, "voice_20260528_235959_abcd.opus"), "legacy");
  let cleanupCalls = 0;
  const logs: string[] = [];
  const tasks = createDailyMaintenanceTasks({
    systemLogStore: {
      cleanupOlderThan(days) {
        cleanupCalls += 1;
        assert.equal(days, 7);
        return 3;
      }
    },
    ttsOutputDirs: [root],
    nowIso: () => "2026-05-29T04:00:00.000",
    log(level, message) {
      logs.push(`${level}:${message}`);
    }
  });

  assert.deepEqual(tasks.map((task) => `${task.id}@${task.hour}:${task.minute}`), [
    "system-log-retention@4:0",
    "tts-generated-retention@4:0"
  ]);
  tasks[0].run();
  tasks[1].run();

  assert.equal(cleanupCalls, 1);
  assert.equal(fs.existsSync(path.join(root, "20260528_235959_999.opus")), false);
  assert.equal(fs.existsSync(path.join(root, "20260529_000000_000.opus")), true);
  assert.equal(fs.existsSync(path.join(root, "voice_20260528_235959_abcd.opus")), true);
  assert.deepEqual(logs, [
    "info:daily cleanup: removed 3 system log file(s) older than 7 days",
    "info:daily cleanup: removed 1 generated tts file(s) from previous days"
  ]);
});

test("cleanupPreviousTtsFiles deduplicates directories and ignores non-tts names", () => {
  const root = makeAssetTempDir("scheduler-tts-cleanup");
  fs.writeFileSync(path.join(root, "20260527_120000_000.wav"), "old wav");
  fs.writeFileSync(path.join(root, "20260527_120000_000.opus"), "old opus");
  fs.writeFileSync(path.join(root, "20260529_120000_000.mp3"), "today");
  fs.writeFileSync(path.join(root, "note.txt"), "keep");

  const removed = cleanupPreviousTtsFiles([root, root], "2026-05-29T04:00:00.000");

  assert.equal(removed, 2);
  assert.equal(fs.existsSync(path.join(root, "20260527_120000_000.wav")), false);
  assert.equal(fs.existsSync(path.join(root, "20260527_120000_000.opus")), false);
  assert.equal(fs.existsSync(path.join(root, "20260529_120000_000.mp3")), true);
  assert.equal(fs.existsSync(path.join(root, "note.txt")), true);
});

test("cleanupPreviousTtsFiles skips directories outside assets", () => {
  const root = makeTempDir("scheduler-outside-assets");
  fs.writeFileSync(path.join(root, "20260527_120000_000.opus"), "old");
  const warnings: string[] = [];

  const removed = cleanupPreviousTtsFiles([root], "2026-05-29T04:00:00.000", (message) => warnings.push(message));

  assert.equal(removed, 0);
  assert.equal(fs.existsSync(path.join(root, "20260527_120000_000.opus")), true);
  assert.match(warnings[0], /must be inside assets/);
});

function makeAssetTempDir(name: string): string {
  const dir = path.join("assets", "generated", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
