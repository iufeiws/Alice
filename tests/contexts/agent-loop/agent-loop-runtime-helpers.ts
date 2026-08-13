import assert from "node:assert/strict";
import type { AgentEvent } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

/**
 * Main Agent activity 占用契约(架构缺口修复轮·第二版, 实现方必须匹配):
 *
 * agentLoopRuntime 的运行占用从"仅包围 requestRun()"扩展为统一的 MainAgentActivity
 * 占用(idle / running / clearing), requestRun 与统一 clear(Chat/Talk/Memorize)
 * 共用同一占用。clear 开始前获取占用(先占用、后清除), 完整结束或失败后释放;
 * 占用期间互斥(requestRun 返回 { started:false }, beginClearSession 返回 { acquired:false })。
 *
 * 占用句柄带唯一 token(问题 1: 内部并发 chat clear 的 token 所有权):
 * - beginClearSession 每次成功获取都返回全新唯一 token; release() 只回收自己 token
 *   名下的占用——过期/他人句柄的 release 不得误释放当前 owner 的占用(release 幂等)。
 * - 内部 clearCurrentLLMSession(reason) 必须持有自己的 token 占用再执行清除本体:
 *   * idle: 先占用、后清除, settle(成功或失败)后释放;
 *   * 外部 chat 占用(beginClearSession, 如 force_wake)已持有: 直接委托执行
 *     (不重复占用、不丢占用), 释放由外部句柄负责;
 *   * 另一内部 chat clear 进行中: 排队等待, 第一个 settle 后接续执行, 全程 busy
 *     连续无 idle 空窗(第二个 settle 后才恢复 idle);
 *   * running(本 runtime 自己的 loop): 占用交接, busy 连续;
 *   * talk/memorize 占用进行中: 拒绝(throw main_agent_clear_in_progress)。
 *
 * 实现方契约(对应 src 新增 API, 导入路径:
 *   src/contexts/agent-loop/src/runtime/agent-loop-runtime.ts):
 * - type MainAgentActivity =
 *     | { phase: "idle" }
 *     | { phase: "running"; kind: "chat" | "talk"; sessionId: string | number }
 *     | { phase: "clearing"; kind: "chat" | "talk" | "memorize"; sessionId: string };
 * - type MainAgentClearAcquisition =
 *     | { acquired: true; token: string; release(): void }
 *     | { acquired: false };
 * - AgentLoopRuntime.isMainAgentBusy(): boolean;      // true 当且仅当 phase !== "idle"
 * - AgentLoopRuntime.getMainAgentActivity(): MainAgentActivity;
 * - AgentLoopRuntime.beginClearSession(input: { kind: ClearableSessionKind; sessionId: string }):
 *     MainAgentClearAcquisition;                       // busy 时拒绝, 不排队
 * - AgentLoopRuntime.clearCurrentLLMSession(reason): 见上方内部 clear 语义(token 所有权)。
 *
 * 测试侧通过 asMainAgentActivityContract() 访问实现方已落地的 API(实现已交付,
 * 契约访问器断言通过即代表实现匹配契约)。
 */

export type MainAgentActivity =
  | { phase: "idle" }
  | { phase: "running"; kind: "chat" | "talk"; sessionId: string | number }
  | { phase: "clearing"; kind: "chat" | "talk" | "memorize"; sessionId: string };

export type MainAgentClearAcquisition =
  | { acquired: true; token: string; release(): void }
  | { acquired: false };

export type MainAgentActivityContract = {
  isMainAgentBusy(): boolean;
  getMainAgentActivity(): MainAgentActivity;
  beginClearSession(input: { kind: "chat" | "talk" | "memorize"; sessionId: string }): MainAgentClearAcquisition;
};

export function asMainAgentActivityContract(runtime: unknown): MainAgentActivityContract {
  const contract = runtime as MainAgentActivityContract;
  assert.equal(typeof contract.isMainAgentBusy, "function", "实现方契约缺失: AgentLoopRuntime.isMainAgentBusy() 未实现");
  assert.equal(typeof contract.getMainAgentActivity, "function", "实现方契约缺失: AgentLoopRuntime.getMainAgentActivity() 未实现");
  assert.equal(typeof contract.beginClearSession, "function", "实现方契约缺失: AgentLoopRuntime.beginClearSession() 未实现");
  return contract;
}

export type HeldMainAgentClearAcquisition = {
  token: string;
  release(): void;
};

export function requireMainAgentClearAcquisition(acquisition: MainAgentClearAcquisition): HeldMainAgentClearAcquisition {
  assert.equal(acquisition.acquired, true, "期望获得 Main Agent clear 占用, 但被拒绝");
  if (!acquisition.acquired) throw new Error("unreachable: clear acquisition rejected");
  return acquisition;
}

export const emptyPromptRenderer = () => testPromptRuntime();

export function fakeTime() {
  return {
    timeZone: "UTC",
    now: () => ({ date: new Date("2026-06-12T00:00:00.000Z"), iso: "2026-06-12T00:00:00.000", epochMs: 1, timeZone: "UTC" }),
    addMs: () => ({ date: new Date("2026-06-12T00:00:00.000Z"), iso: "2026-06-12T00:00:00.000", epochMs: 1, timeZone: "UTC" })
  };
}

export function textEvent(sessionId: string): AgentEvent {
  return {
    id: "evt_1",
    type: "message.text",
    source: { plugin: "test", userId: "user-1" },
    externalSession: { scope: "dm", sessionId },
    payload: { kind: "text", text: "hello" },
    meta: { receivedAt: "2026-06-12T00:00:00.000Z" }
  };
}
