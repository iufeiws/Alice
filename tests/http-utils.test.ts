import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpJsonError, assertLoopbackAdminRequest, isLoopbackAddress, readJsonBody } from "../apps/api/src/http-utils.js";

test("loopback admin guard allows local addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.2"), false);
  assertLoopbackAdminRequest({ url: "/admin/api/config", socket: { remoteAddress: "127.0.0.1" } });
});

test("loopback admin guard rejects remote admin requests", () => {
  assert.throws(
    () => assertLoopbackAdminRequest({ url: "/admin/api/config", socket: { remoteAddress: "10.0.0.2" } }),
    (error) => error instanceof HttpJsonError && error.statusCode === 403 && error.code === "admin_local_only"
  );
});

test("readJsonBody parses objects and rejects invalid input", async () => {
  assert.deepEqual(await readJsonBody(iterateChunks(["{\"ok\":true}"])), { ok: true });
  await assert.rejects(
    () => readJsonBody(iterateChunks(["not json"])),
    (error) => error instanceof HttpJsonError && error.statusCode === 400 && error.code === "invalid_json"
  );
  await assert.rejects(
    () => readJsonBody(iterateChunks(["[]"])),
    (error) => error instanceof HttpJsonError && error.statusCode === 400 && error.code === "invalid_json_object"
  );
  await assert.rejects(
    () => readJsonBody(iterateChunks(["{\"payload\":\"123456\"}"]), { maxBytes: 4 }),
    (error) => error instanceof HttpJsonError && error.statusCode === 413 && error.code === "request_too_large"
  );
});

async function* iterateChunks(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}
