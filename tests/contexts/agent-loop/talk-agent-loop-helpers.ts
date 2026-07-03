import { createTalkAgentLoopForSession } from "../../../src/contexts/agent-loop/src/application/run-talk-loop.js";
import { runAgentFunctionCallLoop } from "../../../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { buildLLMTextVariables, createLLMTextVariableRenderer } from "../../../src/contexts/agent-profile/src/application/llm-text-renderer.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import type { LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";

export function testPromptRenderer() {
  return createLLMTextVariableRenderer({
    variables: () => buildLLMTextVariables({ userName: "user", time: createCurrentTimeProvider("UTC") })
  });
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
