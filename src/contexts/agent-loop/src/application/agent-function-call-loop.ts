import type { LLMToolLoopInput } from "../../../llm-gateway/src/llm-tool-loop.js";

export type AgentFunctionCallLoopSpecInput = LLMToolLoopInput;

export function buildAgentFunctionCallLoopSpec(input: AgentFunctionCallLoopSpecInput): LLMToolLoopInput {
  return input;
}
