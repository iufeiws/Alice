import type { CurrentTimeProvider } from "../../../../core/time/src/index.js";
import {
  clearMemoryInductionSession as clearActiveMemoryInductionSession,
  createMemoryInductionSession,
  type MemoryInductionSession
} from "../memory.js";

export function createMemoryConsoleRuntime(input: {
  sessionRoot(): string;
  time: CurrentTimeProvider;
}) {
  let session: MemoryInductionSession | undefined;

  return {
    ensureSession,
    clearSession
  };

  function ensureSession(windowEndAt: string, windowStartAt?: string): MemoryInductionSession {
    if (!session || session.clearedAt) {
      session = createMemoryInductionSession(input.sessionRoot(), input.time.now().iso, {
        name: "console",
        windowStartAt,
        windowEndAt,
        timezone: input.time.timeZone,
        nowIso: () => input.time.now().iso
      });
    }
    return session;
  }

  function clearSession(): void {
    clearActiveMemoryInductionSession(session, input.time.now().iso, "admin_clear");
    session = undefined;
  }
}
