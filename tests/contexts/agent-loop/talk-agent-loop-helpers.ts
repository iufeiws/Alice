import { createTalkAgentLoopForSession } from "../../../src/contexts/agent-loop/src/application/run-talk-loop.js";
import { runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import type { LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

export function testPromptRenderer() {
  const time = createCurrentTimeProvider("UTC").now();
  return testPromptRuntime({ user: "user", date_time: time.iso.slice(0, 19).replace("T", " "), time: time.iso.slice(11, 19), date: time.iso.slice(0, 10), timezone: time.timeZone });
}

export async function runPreparedTalkAgentLoop(controller: ReturnType<typeof createTalkAgentLoopForSession>, sessionId: number): Promise<void> {
  const prepared = await controller.prepareTalkAgentLoopForSession(sessionId);
  if (!prepared) return;
  try {
    const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
    if (!spec || Array.isArray(spec)) return;
    prepared.complete(await runAgentFunctionCallLoop(spec));
  } catch (error) {
    await prepared.onError?.(error);
  } finally {
    await prepared.dispose?.();
  }
}

export const noopClient: LLMClient = {
  async chat() {
    return { message: { role: "assistant", content: "" }, finishReason: "stop" };
  }
};
