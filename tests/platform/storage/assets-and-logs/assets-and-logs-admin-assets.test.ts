import { test } from "node:test";
import assert from "node:assert/strict";
import { AssetValidationError, resolveAdminAssetPath } from "../../../../src/platform/storage/src/admin-asset-utils.js";
import { fs, makeTempDir, path } from "./assets-and-logs-helpers.js";

test("admin assets resolve allowed relative files under the asset root", () => {
  const root = makeTempDir("admin-assets");
  fs.writeFileSync(path.join(root, "ok.png"), "png");

  assert.equal(
    resolveAdminAssetPath("ok.png", { root, allowedExtensions: [".png"], maxBytes: 10 }),
    path.join(root, "ok.png")
  );
});

test("admin assets reject paths outside the asset root", () => {
  const root = makeTempDir("admin-assets-outside");

  assertAssetError("asset_outside_assets", () => resolveAdminAssetPath("../secret.png", { root, allowedExtensions: [".png"], maxBytes: 10 }));
  assertAssetError("asset_outside_assets", () => resolveAdminAssetPath("./secret.png", { root, allowedExtensions: [".png"], maxBytes: 10 }));
  assertAssetError("asset_must_be_relative", () => resolveAdminAssetPath("/outside-assets/secret.png", { root, allowedExtensions: [".png"], maxBytes: 10 }));
});

test("admin assets reject disallowed file state", () => {
  const root = makeTempDir("admin-assets-state");
  fs.writeFileSync(path.join(root, "ok.png"), "png");

  assertAssetError("asset_extension_not_allowed", () => resolveAdminAssetPath("ok.png", { root, allowedExtensions: [".jpg"], maxBytes: 10 }));
  assertAssetError("asset_too_large", () => resolveAdminAssetPath("ok.png", { root, allowedExtensions: [".png"], maxBytes: 1 }));
  assertAssetError("asset_not_found", () => resolveAdminAssetPath("missing.png", { root, allowedExtensions: [".png"], maxBytes: 10 }));
});

function assertAssetError(code: string, callback: () => unknown): void {
  assert.throws(callback, (error) => error instanceof AssetValidationError && error.code === code);
}
