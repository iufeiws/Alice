import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPiModule, readPiPackageVersion, resolvePiPackageEntry } from "../../../src/contexts/pi-worker/runtime/pi-module-loader.mjs";

test("Pi module loader uses the ESM export when require has no exports main", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-module-loader-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    type: "module",
    version: "0.83.0",
    main: "./legacy.js",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./package.json": "./package.json"
    }
  }));
  fs.writeFileSync(path.join(root, "dist/index.js"), "export const loaded = true;\n");

  assert.equal(resolvePiPackageEntry(root), path.join(root, "dist/index.js"));
  assert.equal(readPiPackageVersion(root), "0.83.0");
  assert.equal((await loadPiModule(root)).loaded, true);
});
