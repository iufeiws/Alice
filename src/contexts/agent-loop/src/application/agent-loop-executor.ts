import {
  runLLMToolLoop,
  type LLMToolLoopExecution,
  type LLMToolLoopInput,
  type LLMToolLoopResult
} from "../../../llm-gateway/src/llm-tool-loop.js";

export type AgentLoopExecutionSpec = LLMToolLoopInput;
export type AgentLoopToolExecution = LLMToolLoopExecution;
export type AgentLoopExecutionResult = LLMToolLoopResult;

export async function runAgentLoopExecutionSpec(spec: AgentLoopExecutionSpec): Promise<AgentLoopExecutionResult> {
  return runLLMToolLoop(spec);
}
