import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpShutdownController } from "./apps/api/src/http-shutdown.js";

const http = await import("node:http") as any;

test("http shutdown forces lingering tracked connections", async () => {
  let destroyed = false;
  let closeAllConnectionsCalled = false;
  const server = {
    close() {
      // Simulate server.close() waiting forever for an active connection.
    },
    closeAllConnections() {
      closeAllConnectionsCalled = true;
    },
    closeIdleConnections() {}
  };
  const socket = {
    once() {},
    end() {},
    destroy() {
      destroyed = true;
    }
  };
  const shutdown = createHttpShutdownController(server);
  shutdown.trackConnection(socket as any);

  const startedAt = Date.now();
  const result = await shutdown.close({ forceAfterMs: 20 });

  assert.equal(result.forced, true);
  assert.equal(result.remainingConnections, 1);
  assert.equal(destroyed, true);
  assert.equal(closeAllConnectionsCalled, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("http shutdown closes real keepalive connections quickly", async () => {
  const server = http.createServer((_request: any, _response: any) => {
    // Keep the request active so server.close() cannot finish by itself.
  });
  const shutdown = createHttpShutdownController(server);
  server.on("connection", (socket: any) => shutdown.trackConnection(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const net = await import("node:net") as any;
  const socket = net.createConnection(address.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
  await new Promise<void>((resolve) => server.once("request", () => resolve()));

  assert.equal(shutdown.activeConnectionCount(), 1);

  const startedAt = Date.now();
  const result = await shutdown.close({ forceAfterMs: 1_000 });

  assert.equal(result.forced, false);
  assert.equal(result.remainingConnections, 0);
  assert.ok(Date.now() - startedAt < 1_000);
  socket.destroy();
});

test("http shutdown resolves gracefully when connections close", async () => {
  const server = http.createServer((_request: any, response: any) => {
    response.writeHead(200, { connection: "close" });
    response.end("ok");
  });
  const shutdown = createHttpShutdownController(server);
  server.on("connection", (socket: any) => shutdown.trackConnection(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await new Promise<void>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: address.port, path: "/" }, (response: any) => {
      response.resume();
      response.once("end", resolve);
    }).once("error", reject);
  });

  const result = await shutdown.close({ forceAfterMs: 1_000 });

  assert.equal(result.forced, false);
  assert.equal(result.remainingConnections, 0);
});
