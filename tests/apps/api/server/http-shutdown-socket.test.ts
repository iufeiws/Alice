import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHttpShutdownController } from "../../../../src/apps/api/server/http-shutdown.js";

test("http shutdown closes tracked real sockets without forcing", async () => {
  const server = http.createServer((_request, response) => {
    response.end("ok");
  });
  const shutdown = createHttpShutdownController(server);
  const serverSocketClosed = new Promise<void>((resolve) => {
    server.on("connection", (socket) => {
      shutdown.trackConnection(socket);
      socket.once("close", () => resolve());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const socket = net.createConnection(address.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));

  assert.equal(shutdown.activeConnectionCount(), 1);

  const result = await shutdown.close({ forceAfterMs: 1_000 });

  assert.deepEqual(result, { forced: false, remainingConnections: 0 });
  await serverSocketClosed;
  assert.equal(shutdown.activeConnectionCount(), 0);
});

test("http shutdown observes normally closed real connections", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { connection: "close" });
    response.end("ok");
  });
  const shutdown = createHttpShutdownController(server);
  server.on("connection", (socket) => shutdown.trackConnection(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await new Promise<void>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: address.port, path: "/" }, (response) => {
      response.resume();
      response.once("end", resolve);
    }).once("error", reject);
  });

  assert.equal(shutdown.activeConnectionCount(), 0);

  const result = await shutdown.close({ forceAfterMs: 1_000 });

  assert.deepEqual(result, { forced: false, remainingConnections: 0 });
});
