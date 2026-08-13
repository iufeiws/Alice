import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { MainAgentClearAcquisition } from "../../../agent-loop/src/runtime/agent-loop-runtime.js";
import type {
  SessionClearCoordinator,
  SessionClearResult
} from "../../../llm-session/src/application/session-clear-coordinator.js";
import {
  clearMemoryInductionSession as clearActiveMemoryInductionSession,
  createMemoryInductionSession,
  type MemoryInductionSession
} from "../memory.js";

export function createMemoryConsoleRuntime(input: {
  sessionRoot(): string;
  time: CurrentTimeProvider;
  /**
   * 统一 Session Clear 协调器（§6 / §7.3）。必填依赖:
   * clearSession 一律走协调器, Short Memory 采集成功后才写 clearedAt/clearReason、
   * 清理 activeTarget、写 final_messages 并释放内存 session 引用(§10);
   * 未注入由类型系统阻止。
   */
  sessionClearCoordinator: SessionClearCoordinator;
  /**
   * Main Agent 统一占用获取口(§7.3/§10): clearSession 在转交 coordinator 前获取
   * clearing 占用(kind "memorize"), 完整结束(成功或失败)后释放; 与 Chat/Talk 清除互斥。
   * 必填依赖，禁止缺失时绕过占用。
   */
  acquireMainAgentClear(input: { kind: "chat" | "talk" | "memorize"; sessionId: string }): MainAgentClearAcquisition;
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

  async function clearSession(reason = "admin_clear"): Promise<SessionClearResult> {
    // §10: 清除入口先获取 Main Agent clearing 占用(kind memorize), 成功或失败后释放;
    // 已占用(如 Chat loop 运行中或另一清除进行中)时拒绝并抛错, 不得静默降级为无占用清除。
    const acquisition = input.acquireMainAgentClear({ kind: "memorize", sessionId: "console" });
    if (!acquisition.acquired) {
      throw new Error("memory console session clear rejected: main agent busy");
    }
    try {
      return await input.sessionClearCoordinator.clearSession({
        kind: "memorize",
        sessionId: "console",
        reason,
        exists: () => Boolean(session && !session.clearedAt),
        clear: () => {
          clearActiveMemoryInductionSession(session, input.time.now().iso, reason);
          session = undefined;
        }
      });
    } finally {
      acquisition.release();
    }
  }
}
