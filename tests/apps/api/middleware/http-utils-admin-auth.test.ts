import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLoopbackAdminRequest } from "../../../../src/apps/api/middleware/http-utils.js";
import { httpJsonError } from "./http-utils-helpers.js";

test("admin auth allows local and LAN admin requests", () => {
  assertLoopbackAdminRequest({ url: "/admin/api/config", socket: { remoteAddress: "127.0.0.1" } });
  assertLoopbackAdminRequest({ url: "/admin/api/config", socket: { remoteAddress: "10.0.0.2" } });
});

test("admin auth rejects public remote admin requests", () => {
  assert.throws(
    () => assertLoopbackAdminRequest({ url: "/admin/api/config", socket: { remoteAddress: "8.8.8.8" } }),
    httpJsonError(403, "admin_lan_only")
  );
});

test("admin auth leaves non-admin requests unguarded", () => {
  assertLoopbackAdminRequest({ url: "/api/status", socket: { remoteAddress: "8.8.8.8" } });
});
