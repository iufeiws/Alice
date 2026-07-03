import { test } from "node:test";
import assert from "node:assert/strict";
import type net from "node:net";
import { createHttpShutdownController } from "../../../../src/apps/api/server/http-shutdown.js";

test("http shutdown resolves gracefully when tracked connections close", async () => {
  let closeCallback: (() => void) | undefined;
  let closeCalled = false;
  let closeIdleConnectionsCalled = false;
  let endCalled = false;
  let destroyCalled = false;
  let onSocketClose: (() => void) | undefined;
  const server = {
    close(callback?: () => void) {
      closeCalled = true;
      closeCallback = callback;
    },
    closeIdleConnections() {
      closeIdleConnectionsCalled = true;
    }
  };
  const socket = {
    once(event: string, listener: () => void) {
      assert.equal(event, "close");
      onSocketClose = listener;
      return socket;
    },
    end() {
      endCalled = true;
      onSocketClose?.();
      closeCallback?.();
      return socket;
    },
    destroy() {
      destroyCalled = true;
      return socket;
    }
  } as unknown as net.Socket;
  const shutdown = createHttpShutdownController(server);
  shutdown.trackConnection(socket);

  const result = await shutdown.close({ forceAfterMs: 1_000 });

  assert.deepEqual(result, { forced: false, remainingConnections: 0 });
  assert.equal(closeCalled, true);
  assert.equal(closeIdleConnectionsCalled, true);
  assert.equal(endCalled, true);
  assert.equal(destroyCalled, false);
  assert.equal(shutdown.activeConnectionCount(), 0);
});

test("http shutdown forces lingering tracked connections", async () => {
  let closeCalled = false;
  let closeAllConnectionsCalled = false;
  let closeIdleConnectionsCalled = false;
  let endCalled = false;
  let destroyCalled = false;
  const server = {
    close() {
      closeCalled = true;
    },
    closeAllConnections() {
      closeAllConnectionsCalled = true;
    },
    closeIdleConnections() {
      closeIdleConnectionsCalled = true;
    }
  };
  const socket = {
    once() {
      return socket;
    },
    end() {
      endCalled = true;
      return socket;
    },
    destroy() {
      destroyCalled = true;
      return socket;
    }
  } as unknown as net.Socket;
  const shutdown = createHttpShutdownController(server);
  shutdown.trackConnection(socket);

  const startedAt = Date.now();
  const result = await shutdown.close({ forceAfterMs: 20 });

  assert.deepEqual(result, { forced: true, remainingConnections: 1 });
  assert.equal(closeCalled, true);
  assert.equal(closeIdleConnectionsCalled, true);
  assert.equal(endCalled, true);
  assert.equal(closeAllConnectionsCalled, true);
  assert.equal(destroyCalled, true);
  assert.ok(Date.now() - startedAt < 1_000);
});
