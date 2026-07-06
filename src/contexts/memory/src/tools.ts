import type { ToolDefinition, ToolPlugin } from '../../agent-loop/src/contracts/agent-contracts.js';
import type { LLMClient, LLMToolSpec } from '../../../contexts/llm-gateway/src/index.js';
import type { LLMRequestSender } from '../../../contexts/llm-gateway/src/llm-tool-loop.js';
import type { MemoryRunResult } from './model.js';
import { targetResultFiles } from './model.js';
import { editTool, readTool } from '../../../capabilities/tools/sandbox-file-tools/src/sandbox-file-tools.js';

export const memoryToolNames = ["Read", "Edit", "self_talk"] as const;

const selfTalkTool: ToolDefinition = {
  name: "self_talk",
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

export function memoryToolDefinitions(): ToolDefinition[] {
  return [readTool, editTool, selfTalkTool];
}

export function createMemorySelfTalkToolPlugin(input: {
  toolCalls: MemoryRunResult["toolCalls"];
}): ToolPlugin {
  return {
    id: "memory_self_talk",
    listTools: () => [selfTalkTool],
    async execute(call) {
      if (call.toolName === "self_talk") {
        const content = typeof call.input.content === "string" ? call.input.content : "";
        const output = `爱丽丝听到自己说:\n${content}`;
        input.toolCalls.push({ name: "self_talk", file: targetResultFiles.persistent, input: call.input, ok: true, output });
        return { callId: call.id, ok: true, output };
      }
      throw new Error(`unknown tool: ${call.toolName}`);
    }
  };
}

export function memoryTools(): LLMToolSpec[] {
  return memoryToolDefinitions().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

export function createMemoryLocalLLMRequestSender(llm: LLMClient | undefined): LLMRequestSender {
  return async (input) => {
    if (!llm) throw new Error("missing Memorize API preset or API key");
    const request = {
      messages: input.messages,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      extraParams: input.extraParams,
      tools: memoryTools()
    };
    return input.stream === true && llm.chatStream
      ? llm.chatStream(request, input.streamHandlers)
      : llm.chat(request);
  };
}
