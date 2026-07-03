import { test } from "node:test";
import assert from "node:assert/strict";
import { readJsonBody } from "../../../../src/apps/api/middleware/http-utils.js";
import { chunks, httpJsonError } from "./http-utils-helpers.js";

test("JSON body reader parses object bodies", async () => {
  assert.deepEqual(await readJsonBody(chunks(["{\"ok\":true}"])), { ok: true });
});

test("JSON body reader treats an empty body as an empty object", async () => {
  assert.deepEqual(await readJsonBody(chunks([])), {});
});

test("JSON body reader rejects invalid JSON", async () => {
  await assert.rejects(
    () => readJsonBody(chunks(["not json"])),
    httpJsonError(400, "invalid_json")
  );
});

test("JSON body reader rejects non-object JSON", async () => {
  await assert.rejects(
    () => readJsonBody(chunks(["[]"])),
    httpJsonError(400, "invalid_json_object")
  );
});

test("JSON body reader rejects oversized bodies", async () => {
  await assert.rejects(
    () => readJsonBody(chunks(["{\"payload\":\"123456\"}"]), { maxBytes: 4 }),
    httpJsonError(413, "request_too_large")
  );
});
