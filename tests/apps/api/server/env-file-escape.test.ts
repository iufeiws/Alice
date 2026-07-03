import { test } from "node:test";
import assert from "node:assert/strict";
import { updateEnvFile } from "../../../../src/apps/api/server/env-file.js";
import { envFilePath, readEnvFile } from "./env-file-helpers.js";

test("updateEnvFile JSON-quotes values with surrounding whitespace or newlines", () => {
  const file = envFilePath("alice-env-escape");

  updateEnvFile(file, {
    LEADING_SPACE: " value",
    TRAILING_SPACE: "value ",
    MULTILINE: "first\nsecond",
    PLAIN: "value"
  });

  assert.equal(readEnvFile(file), [
    "LEADING_SPACE=\" value\"",
    "TRAILING_SPACE=\"value \"",
    "MULTILINE=\"first\\nsecond\"",
    "PLAIN=value",
    ""
  ].join("\n"));
});
