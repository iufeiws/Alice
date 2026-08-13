import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTalkRuntime } from "../../../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { createTalkStore } from "../../../src/contexts/talk-session/src/adapters/sqlite-talk-session-store.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import type {
  SessionClearCoordinator,
  SessionClearRequest
} from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";

export { createCurrentTimeProvider, createTalkRuntime, createTalkStore, path };

/**
 * 结构等价 createSessionClearCoordinator 产物的 fake（§7.1: coordinator 为统一入口,
 * 任何 clear 路径都必须经过它, 不存在绕过采集的兼容 fallback）。测试不关心 Short
 * Memory 采集, 只要求 clear 回调被执行并返回完整 SessionClearResult。
 */
export const fakeSessionClearCoordinator: SessionClearCoordinator = {
  async clearSession(request: SessionClearRequest) {
    if (!request.exists()) return { cleared: false, shortMemoryCaptured: false };
    await request.clear();
    return { cleared: true, shortMemoryCaptured: false };
  }
};

export const fakeAcquireMainAgentClear = () => ({ acquired: true as const, token: "test-clear", release() {} });
export const fakeRewriteActiveTalkLLMSessionFromRuntime = () => {};
export const fakeClearActiveTalkLLMSession = () => {};

export function createTestRuntime(
  name: string,
  prepareAgentLoop?: (sessionId: number) => void,
  interruptAgentLoop?: (sessionId: number, outputId: string) => void,
  createLLMSession?: () => number,
  now?: () => Date
): ReturnType<typeof createTalkRuntime> {
  const store = createTalkStore(path.join(makeTempDir(`talk-runtime-${name}`), "talk.sqlite"));
  const time = createCurrentTimeProvider("Asia/Tokyo", now ?? (() => new Date("2026-06-06T15:00:00.000Z")));
  return createTalkRuntime({
    store,
    time,
    prepareAgentLoop,
    interruptAgentLoop,
    createLLMSession,
    sessionClearCoordinator: fakeSessionClearCoordinator,
    acquireMainAgentClear: fakeAcquireMainAgentClear,
    rewriteActiveTalkLLMSessionFromRuntime: fakeRewriteActiveTalkLLMSessionFromRuntime,
    clearActiveTalkLLMSession: fakeClearActiveTalkLLMSession
  });
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
