import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionDirtyFlagger } from "../core/input-buffer/src/index.js";
import { loadConfig } from "../packages/config/src/index.js";

test("session dirty flagger waits before processing a dirty session", async () => {
  const processed: string[] = [];
  const flagger = createSessionDirtyFlagger(
    () => 20,
    async (sessionId) => {
      processed.push(sessionId);
    }
  );

  flagger.markDirty("session-a");
  flagger.markDirty("session-a");
  await waitFor(() => processed.length === 1);

  assert.deepEqual(processed, ["session-a"]);
});

test("session dirty flagger does not process a dirty session concurrently", async () => {
  const processed: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const flagger = createSessionDirtyFlagger(
    () => 10,
    async (sessionId) => {
      processed.push(sessionId);
      if (processed.length === 1) {
        await firstBlocked;
      }
    }
  );

  flagger.markDirty("session-a");
  await waitFor(() => processed.length === 1);
  flagger.markDirty("session-a");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(processed.length, 1);

  releaseFirst();
  await waitFor(() => processed.length === 2);
  assert.deepEqual(processed, ["session-a", "session-a"]);
});

test("session dirty flagger separates sessions", async () => {
  const processed: string[] = [];
  const flagger = createSessionDirtyFlagger(
    () => 10,
    async (sessionId) => {
      processed.push(sessionId);
    }
  );

  flagger.markDirty("session-a");
  flagger.markDirty("session-b");
  await waitFor(() => processed.length === 2);

  assert.deepEqual(processed.sort(), ["session-a", "session-b"]);
});

test("agent inbound debounce config defaults to one second and can be overridden", () => {
  assert.equal(loadConfig({}).core.inboundDebounceMs, 1000);
  assert.equal(loadConfig({ AGENT_INBOUND_DEBOUNCE_MS: "2500" }).core.inboundDebounceMs, 2500);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
