import { test } from "node:test";
import assert from "node:assert/strict";
import { createFileLogStore } from "../../../../src/contexts/conversation-hub/src/adapters/file-log-store.js";
import { fs, makeTempDir, path, readJsonl } from "./assets-and-logs-helpers.js";

test("file log store writes entries to configured local-date files and reads recent logs", () => {
  const root = makeTempDir("file-logs");
  const store = createFileLogStore(root, { timeZone: "Asia/Shanghai" });

  const entry = store.append({
    time: "2026-05-24T02:00:00.000",
    utcTime: "2026-05-23T18:00:00.000Z",
    level: "info",
    message: "local date should be next day"
  });
  const filePath = path.join(root, "2026-05-24.log.jsonl");

  assert.deepEqual(readJsonl(filePath), [entry]);
  assert.deepEqual(store.listRecent(1), [entry]);
});

test("file log store cleanup removes files older than configured local retention", () => {
  const root = makeTempDir("file-logs-cleanup");
  const store = createFileLogStore(root, { timeZone: "Asia/Shanghai" });

  fs.writeFileSync(path.join(root, "2026-05-16.log.jsonl"), "{\"id\":1,\"time\":\"2026-05-16T00:00:00.000\",\"level\":\"info\",\"message\":\"old\"}\n");
  fs.writeFileSync(path.join(root, "2026-05-18.log.jsonl"), "{\"id\":2,\"time\":\"2026-05-18T00:00:00.000\",\"level\":\"info\",\"message\":\"kept\"}\n");

  assert.equal(store.cleanupOlderThan(7, new Date("2026-05-24T20:00:00.000Z")), 1);
  assert.equal(fs.existsSync(path.join(root, "2026-05-16.log.jsonl")), false);
  assert.equal(fs.existsSync(path.join(root, "2026-05-18.log.jsonl")), true);
});

test("file log store resolves timezone dynamically when writing", () => {
  const root = makeTempDir("file-logs-dynamic");
  let timeZone = "UTC";
  const store = createFileLogStore(root, { getTimeZone: () => timeZone });

  store.append({
    time: "2026-05-23T18:00:00.000Z",
    level: "info",
    message: "utc date"
  });
  timeZone = "Asia/Singapore";
  store.append({
    time: "2026-05-23T18:00:00.000Z",
    level: "info",
    message: "singapore date"
  });

  assert.equal(fs.existsSync(path.join(root, "2026-05-23.log.jsonl")), true);
  assert.equal(fs.existsSync(path.join(root, "2026-05-24.log.jsonl")), true);
});

test("file log store keeps persisted ids and lists recent entries across log files", () => {
  const root = makeTempDir("file-logs-state");
  fs.writeFileSync(path.join(root, "2026-05-20.log.jsonl"), [
    "{\"id\":1,\"time\":\"2026-05-20T00:00:00.000\",\"level\":\"info\",\"message\":\"old-1\"}",
    "{\"id\":2,\"time\":\"2026-05-20T00:00:01.000\",\"level\":\"info\",\"message\":\"old-2\"}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(root, "2026-05-21.log.jsonl"), "{\"id\":3,\"time\":\"2026-05-21T00:00:00.000\",\"level\":\"info\",\"message\":\"middle\"}\n");
  fs.writeFileSync(path.join(root, "2026-05-22.log.jsonl"), [
    "{\"id\":4,\"time\":\"2026-05-22T00:00:00.000\",\"level\":\"info\",\"message\":\"latest-1\"}",
    "{\"id\":5,\"time\":\"2026-05-22T00:00:01.000\",\"level\":\"info\",\"message\":\"latest-2\"}",
    ""
  ].join("\n"));
  const store = createFileLogStore(root, { timeZone: "UTC" });

  assert.deepEqual(store.listRecent(3).map((entry) => entry.message), ["middle", "latest-1", "latest-2"]);
  assert.equal(store.append({
    time: "2026-05-22T00:00:02.000",
    level: "info",
    message: "next"
  }).id, 6);
});
