import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpJsonError } from "../../../../src/apps/api/middleware/http-utils.js";

test("HTTP JSON errors expose response status and error code", () => {
  const error = new HttpJsonError(400, "invalid_json");

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "invalid_json");
  assert.ok(error instanceof Error);
});
