import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAdminAssetPath } from "../apps/api/src/asset-utils.js";
import { createFileLogStore } from "../packages/storage/src/file-log-store.js";

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
    () => resolveAdminAssetPath("../secret.png", { root, allowedExtensions: [".png"], maxBytes: 10 }),
    /asset_outside_assets/
  );
  assert.throws(
    () => resolveAdminAssetPath("/tmp/secret.png", { root, allowedExtensions: [".png"], maxBytes: 10 }),
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

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
