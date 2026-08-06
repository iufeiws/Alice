import type { ToolCall, ToolDefinition, ToolPlugin } from "../../agent-loop/src/contracts/agent-contracts.js";
import type { LLMToolSpec } from "../../llm-gateway/src/index.js";
import type { MemoryRunResult } from "./model.js";
import { targetResultFiles } from "./model.js";

/**
 * Memorize 私密思考工具：只把中间步骤记进 toolCalls，不写入记忆文件，
 * 也不向用户发送任何消息。memorize-prompts.json 依赖此工具总结中间步骤。
 */
export const memorySelfTalkToolName = "self_talk";

export const memorySelfTalkDefinition: ToolDefinition = {
  name: memorySelfTalkToolName,
  description: "对自己说话",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "对自己说的话"
      }
    },
    required: ["content"],
    additionalProperties: false
  }
};

export const memorySelfTalkSpec: LLMToolSpec = {
  type: "function",
  function: {
    name: memorySelfTalkToolName,
    description: memorySelfTalkDefinition.description,
    parameters: memorySelfTalkDefinition.inputSchema
  }
};

export function createMemorySelfTalkToolPlugin(input: { toolCalls: MemoryRunResult["toolCalls"] }): ToolPlugin {
  return {
    id: "memory_self_talk",
    listTools: () => [memorySelfTalkDefinition],
    async execute(call: ToolCall) {
      if (call.toolName !== memorySelfTalkToolName) throw new Error(`unknown tool: ${call.toolName}`);
      const content = typeof call.input.content === "string" ? call.input.content : "";
      const output = `爱丽丝听到自己说:\n${content}`;
      input.toolCalls.push({
        name: memorySelfTalkToolName,
        file: targetResultFiles.persistent,
        input: call.input,
        ok: true,
        output
      });
      return { callId: call.id, ok: true, output };
    }
  };
}
