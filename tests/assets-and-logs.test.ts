import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAdminAssetPath } from "../src/apps/api/routes/asset-utils.js";
import { createApiLogRuntime } from "../src/apps/api/bootstrap/api-log-runtime.js";
import { createFileLogStore } from "../src/contexts/conversation-hub/src/adapters/file-log-store.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("admin assets are constrained to the configured asset root", () => {
  const root = makeTempDir("assets");
  fs.writeFileSync(path.join(root, "ok.png"), "png");

  assert.equal(
    resolveAdminAssetPath("ok.png", { root, allowedExtensions: [".png"], maxBytes: 10 }),
    path.join(root, "ok.png")
  );
  assert.throws(
    () => resolveAdminAssetPath("./secret.png", { root, allowedExtensions: [".png"], maxBytes: 10 }),
    /asset_outside_assets/
  );
  assert.throws(
    () => resolveAdminAssetPath("/outside-assets/secret.png", { root, allowedExtensions: [".png"], maxBytes: 10 }),
    /asset_must_be_relative/
  );
  assert.throws(
    () => resolveAdminAssetPath("ok.png", { root, allowedExtensions: [".jpg"], maxBytes: 10 }),
    /asset_extension_not_allowed/
  );
  assert.throws(
    () => resolveAdminAssetPath("ok.png", { root, allowedExtensions: [".png"], maxBytes: 1 }),
    /asset_too_large/
  );
});

test("file log store uses configured local date for file names and cleanup", () => {
  const root = makeTempDir("logs");
  const store = createFileLogStore(root, { timeZone: "Asia/Shanghai" });

  store.append({
    time: "2026-05-23T18:00:00.000Z",
    level: "info",
    message: "local date should be next day"
  });
  assert.ok(fs.existsSync(path.join(root, "2026-05-24.log.jsonl")));

  fs.writeFileSync(path.join(root, "2026-05-16.log.jsonl"), "{\"id\":1,\"time\":\"2026-05-16T00:00:00.000Z\",\"level\":\"info\",\"message\":\"old\"}\n");
  const removed = store.cleanupOlderThan(7, new Date("2026-05-24T20:00:00.000Z"));
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(path.join(root, "2026-05-16.log.jsonl")), false);
});

test("file log store resolves timezone dynamically", () => {
  const root = makeTempDir("logs-dynamic");
  let timeZone = "UTC";
  const store = createFileLogStore(root, { getTimeZone: () => timeZone });

  store.append({
    time: "2026-05-23T18:00:00.000Z",
    level: "info",
    message: "utc date"
  });
  assert.ok(fs.existsSync(path.join(root, "2026-05-23.log.jsonl")));

  timeZone = "Asia/Singapore";
  store.append({
    time: "2026-05-23T18:00:00.000Z",
    level: "info",
    message: "singapore date"
  });
  assert.ok(fs.existsSync(path.join(root, "2026-05-24.log.jsonl")));
});

test("file log store initializes ids from latest log file and lists recent entries from newest files", () => {
  const root = makeTempDir("logs-latest-only");
  fs.writeFileSync(path.join(root, "2026-05-20.log.jsonl"), [
    "{\"id\":1,\"time\":\"2026-05-20T00:00:00.000Z\",\"level\":\"info\",\"message\":\"old-1\"}",
    "{\"id\":2,\"time\":\"2026-05-20T00:00:01.000Z\",\"level\":\"info\",\"message\":\"old-2\"}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(root, "2026-05-21.log.jsonl"), "{\"id\":3,\"time\":\"2026-05-21T00:00:00.000Z\",\"level\":\"info\",\"message\":\"middle\"}\n");
  fs.writeFileSync(path.join(root, "2026-05-22.log.jsonl"), [
    "{\"id\":4,\"time\":\"2026-05-22T00:00:00.000Z\",\"level\":\"info\",\"message\":\"latest-1\"}",
    "{\"id\":5,\"time\":\"2026-05-22T00:00:01.000Z\",\"level\":\"info\",\"message\":\"latest-2\"}",
    ""
  ].join("\n"));

  const store = createFileLogStore(root, { timeZone: "UTC" });

  assert.deepEqual(store.listRecent(3).map((entry) => entry.message), ["middle", "latest-1", "latest-2"]);
  assert.equal(store.append({
    time: "2026-05-22T00:00:02.000Z",
    level: "info",
    message: "next"
  }).id, 6);
});

test("api log runtime drops noisy WebRTC playback status logs", () => {
  let current = new Date("2026-05-23T00:00:00.000Z");
  const appended: Array<{ level: string; message: string }> = [];
  const runtime = createApiLogRuntime({
    time: createCurrentTimeProvider("UTC", () => current),
    getMessageStore: () => undefined,
    getSystemLogStore: () => ({
      append(input: { level: "info" | "warn" | "error"; message: string }) {
        appended.push(input);
        return { id: appended.length, time: current.toISOString(), ...input };
      },
      listRecent: () => [],
      cleanupOlderThan: () => 0
    })
  });

  const noisy = "webrtc voice tts.queue.backpressure: output-a active=2 reserved=0";
  const noisyChanged = "webrtc voice tts.queue.backpressure: output-b active=1 reserved=1";
  runtime.appendLog("info", noisy);
  current = new Date(current.getTime() + 20);
  runtime.appendLog("info", noisyChanged);
  runtime.appendLog("info", "webrtc voice tts.queue.underrun: sent=10 queued=0");
  runtime.appendLog("info", "webrtc voice voice_call.playback_text_cache: {\"text\":\"hello\"}");
  runtime.appendLog("info", "ordinary log");
  runtime.appendLog("warn", noisyChanged);

  assert.deepEqual(appended.map((entry) => entry.message), [
    "ordinary log",
    noisyChanged
  ]);
  assert.deepEqual(runtime.logs.map((entry) => entry.message), appended.map((entry) => entry.message));
});

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
