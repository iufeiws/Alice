import type {
  LLMToolLoopInput,
  LLMToolLoopLimits
} from "../../../llm-gateway/src/llm-tool-loop.js";

export const defaultAgentFunctionCallLoopLimits: Required<LLMToolLoopLimits> = {
  maxRounds: 20,
  maxTotalToolCalls: 20
};

export type AgentFunctionCallLoopSpecInput = LLMToolLoopInput;

export function buildAgentFunctionCallLoopSpec(input: AgentFunctionCallLoopSpecInput): LLMToolLoopInput {
  return {
    ...input,
    limits: {
      ...defaultAgentFunctionCallLoopLimits,
      ...(input.limits ?? {})
    }
  };
}
