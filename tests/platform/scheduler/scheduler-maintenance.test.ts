import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupPreviousTtsFiles, createDailyMaintenanceTasks } from "../../../src/apps/api/bootstrap/daily-maintenance-runtime.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

test("daily maintenance runs system log cleanup", async () => {
  let logCleanupDays: number | undefined;
  const tasks = createDailyMaintenanceTasks({
    systemLogStore: {
      cleanupOlderThan(days) {
        logCleanupDays = days;
        return 3;
      }
    },
    ttsOutputDirs: [],
    nowIso: () => "2026-05-29T04:00:00.000",
    log() {}
  });

  await runTasks(tasks);
  assert.equal(typeof logCleanupDays, "number");
});

test("daily maintenance runs generated tts cleanup", async () => {
  const fixture = makeAssetTempDir("scheduler-maintenance");
  const root = fixture.ttsDir;
  fs.writeFileSync(path.join(root, "20260528_235959_999.opus"), "old");
  const tasks = createDailyMaintenanceTasks({
    systemLogStore: { cleanupOlderThan: () => 0 },
    ttsOutputDirs: [root],
    ttsAssetRoot: fixture.assetRoot,
    nowIso: () => "2026-05-29T04:00:00.000",
    log() {}
  });

  await runTasks(tasks);

  assert.equal(fs.existsSync(path.join(root, "20260528_235959_999.opus")), false);
});

test("daily maintenance can disable generated tts cleanup", async () => {
  const fixture = makeAssetTempDir("scheduler-maintenance-disabled");
  const root = fixture.ttsDir;
  fs.writeFileSync(path.join(root, "20260528_235959_999.opus"), "old");
  const tasks = createDailyMaintenanceTasks({
    systemLogStore: { cleanupOlderThan: () => 0 },
    ttsOutputDirs: [root],
    ttsGeneratedCleanupEnabled: false,
    nowIso: () => "2026-05-29T04:00:00.000",
    log() {}
  });

  await runTasks(tasks);

  assert.equal(fs.existsSync(path.join(root, "20260528_235959_999.opus")), true);
});

test("cleanupPreviousTtsFiles removes previous-day tts files once per directory", () => {
  const fixture = makeAssetTempDir("scheduler-tts-cleanup");
  const root = fixture.ttsDir;
  fs.writeFileSync(path.join(root, "20260527_120000_000.wav"), "old wav");
  fs.writeFileSync(path.join(root, "20260527_120000_000.opus"), "old opus");

  const removed = cleanupPreviousTtsFiles([root, root], "2026-05-29T04:00:00.000", undefined, fixture.assetRoot);

  assert.equal(removed, 2);
  assert.equal(fs.existsSync(path.join(root, "20260527_120000_000.wav")), false);
  assert.equal(fs.existsSync(path.join(root, "20260527_120000_000.opus")), false);
});

test("cleanupPreviousTtsFiles keeps current-day tts files", () => {
  const fixture = makeAssetTempDir("scheduler-tts-cleanup-keep");
  const root = fixture.ttsDir;
  fs.writeFileSync(path.join(root, "20260529_120000_000.mp3"), "today");

  cleanupPreviousTtsFiles([root], "2026-05-29T04:00:00.000", undefined, fixture.assetRoot);

  assert.equal(fs.existsSync(path.join(root, "20260529_120000_000.mp3")), true);
});

test("cleanupPreviousTtsFiles keeps non-tts files", () => {
  const fixture = makeAssetTempDir("scheduler-tts-cleanup-keep-non-tts");
  const root = fixture.ttsDir;
  fs.writeFileSync(path.join(root, "note.txt"), "keep");

  cleanupPreviousTtsFiles([root], "2026-05-29T04:00:00.000", undefined, fixture.assetRoot);

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

async function runTasks(tasks: ReturnType<typeof createDailyMaintenanceTasks>): Promise<void> {
  for (const task of tasks) await task.run();
}

function makeAssetTempDir(name: string): { assetRoot: string; ttsDir: string } {
  const assetRoot = path.join(makeTempDir(`${name}-assets-root`), "assets");
  const ttsDir = path.join(assetRoot, "generated", "tts");
  fs.mkdirSync(ttsDir, { recursive: true });
  return { assetRoot, ttsDir };
}

function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
