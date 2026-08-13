import { describeError } from "../../../../shared/errors/src/index.js";
import type { ShortMemoryCaptureResult, ShortMemoryWorker } from "../../../memory/src/short-memory-worker.js";

export type ClearableSessionKind = "chat" | "talk" | "memorize";

export type SessionClearReason = string;

export type SessionClearRequest = {
  kind: ClearableSessionKind;
  sessionId: string;
  reason: SessionClearReason;
  exists(): boolean;
  clear(): Promise<void> | void;
};

export type SessionClearResult = {
  cleared: boolean;
  shortMemoryCaptured: boolean;
};

export type SessionClearCoordinator = {
  clearSession(request: SessionClearRequest): Promise<SessionClearResult>;
};

export function createSessionClearCoordinator(input: {
  shortMemoryWorker: ShortMemoryWorker;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}): SessionClearCoordinator {
  // 单一串行队列：后一个 clear 请求必须等前一个完整结束（成功或失败）才开始。
  let queue: Promise<void> = Promise.resolve();
  return {
    clearSession(request: SessionClearRequest): Promise<SessionClearResult> {
      const run = queue.then(() => runClearRequest(input, request));
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }
  };
}

async function runClearRequest(
  input: {
    shortMemoryWorker: ShortMemoryWorker;
    appendLog(level: "info" | "warn" | "error", message: string): void;
  },
  request: SessionClearRequest
): Promise<SessionClearResult> {
  // exists() 必须在轮到该请求执行时求值（§6.2），而不是入队时读取陈旧状态。
  if (!request.exists()) {
    input.appendLog(
      "info",
      `session-clear ${request.kind} session=${request.sessionId} reason=${request.reason} cleared=false captured=false`
    );
    return { cleared: false, shortMemoryCaptured: false };
  }
  let capture: ShortMemoryCaptureResult;
  try {
    capture = await input.shortMemoryWorker.captureBeforeSessionClear();
  } catch (error) {
    input.appendLog(
      "error",
      `session-clear ${request.kind} session=${request.sessionId} reason=${request.reason} captured=false error=${describeError(error)}`
    );
    throw error;
  }
  try {
    await request.clear();
  } catch (error) {
    input.appendLog(
      "error",
      `session-clear ${request.kind} session=${request.sessionId} reason=${request.reason} captured=${capture.captured} error=${describeError(error)}`
    );
    throw error;
  }
  input.appendLog(
    "info",
    `session-clear ${request.kind} session=${request.sessionId} reason=${request.reason} cleared=true captured=${capture.captured}`
  );
  return { cleared: true, shortMemoryCaptured: capture.captured };
}
