import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackAddress, isPrivateNetworkAddress } from "../../../../src/apps/api/middleware/http-utils.js";

test("network address classifier accepts loopback addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
});

test("network address classifier accepts private LAN addresses", () => {
  assert.equal(isPrivateNetworkAddress("10.0.0.2"), true);
  assert.equal(isPrivateNetworkAddress("172.16.0.2"), true);
  assert.equal(isPrivateNetworkAddress("172.31.255.255"), true);
  assert.equal(isPrivateNetworkAddress("192.168.1.20"), true);
  assert.equal(isPrivateNetworkAddress("::ffff:192.168.1.20"), true);
  assert.equal(isPrivateNetworkAddress("fd00::1"), true);
  assert.equal(isPrivateNetworkAddress("fe80::1"), true);
});

test("network address classifier rejects public or missing addresses", () => {
  assert.equal(isLoopbackAddress("8.8.8.8"), false);
  assert.equal(isPrivateNetworkAddress("8.8.8.8"), false);
  assert.equal(isPrivateNetworkAddress(undefined), false);
});
