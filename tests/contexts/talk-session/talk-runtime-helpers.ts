import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";

export { createCurrentTimeProvider, createTalkRuntime, createTalkStore, path };

export function createTestRuntime(
  name: string,
  prepareAgentLoop?: (sessionId: number) => void,
  interruptAgentLoop?: (sessionId: number, outputId: string) => void,
  createLLMSession?: () => number,
  now?: () => Date
): ReturnType<typeof createTalkRuntime> {
  const store = createTalkStore(path.join(makeTempDir(`talk-runtime-${name}`), "talk.sqlite"));
  const time = createCurrentTimeProvider("Asia/Tokyo", now ?? (() => new Date("2026-06-06T15:00:00.000Z")));
  return createTalkRuntime({ store, time, prepareAgentLoop, interruptAgentLoop, createLLMSession });
}

export function sessionInput(sessionId: number) {
  return {
    sessionId,
    source: { plugin: "webrtc_voice", accountId: "main", channelId: "call-1", userId: "browser-1" },
    occurredAt: "2026-06-07T00:00:00.000",
    occurredAtUtc: "2026-06-06T15:00:00.000Z",
    metadata: { language: "ja", callId: "call-1" }
  };
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
