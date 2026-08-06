import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { PiSandboxRuntime, PiToolDefinition, PiContent } from "../../../../contexts/pi-sandbox/src/index.js";
import { piToolResultToToolResult } from "../../../../contexts/pi-sandbox/src/index.js";

const exposedToolNames = new Map([["read", "Read"], ["write", "Write"], ["edit", "Edit"], ["bash", "Bash"]]);

export function createPiToolAdapter(input: {
  runtime: PiSandboxRuntime;
  recognizeImage?(path: string): Promise<{ text: string }>;
  resolveImagePath?(path: string): string | undefined;
}): ToolPlugin {
  return {
    id: "pi_tools",
    listTools() {
      return input.runtime.toolDefinitions()
        .filter((definition) => exposedToolNames.has(definition.name))
        .map((definition) => mapDefinition(definition));
    },
    async execute(call, context) {
      const piName = [...exposedToolNames.entries()].find(([, aliceName]) => aliceName === call.toolName)?.[0];
      if (!piName) throw new Error(`pi_tool_unavailable:${call.toolName}`);
      const result = await input.runtime.executeTool({ requestId: call.id, toolName: piName, input: call.input, context });
      const imageContent = result.content?.filter((part) => part.type === "image") ?? [];
      if (result.ok && imageContent.length > 0) {
        if (context?.llmCapabilities?.supportsImage !== true) return await convertImages(call, result.content!, input.recognizeImage, input.resolveImagePath);
        const output = piToolResultToToolResult(call.id, result);
        return {
          ...output,
          llmFollowupAttachments: imageContent.map((part) => ({
            kind: "image" as const,
            path: input.resolveImagePath?.(part.path) ?? part.path,
            mime: part.mime
          }))
        };
      }
      return piToolResultToToolResult(call.id, result);
    }
  };
}

function mapDefinition(definition: PiToolDefinition): ToolDefinition {
  return {
    name: exposedToolNames.get(definition.name)!,
    description: definition.description,
    inputSchema: definition.inputSchema
  };
}

async function convertImages(call: ToolCall, content: PiContent[], recognizeImage?: (path: string) => Promise<{ text: string }>, resolveImagePath?: (path: string) => string | undefined): Promise<ToolResult> {
  if (!recognizeImage) throw new Error("pi_read_image_recognition_required");
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "text") texts.push(part.text);
    else texts.push((await recognizeImage(resolveImagePath?.(part.path) ?? part.path)).text);
  }
  return { callId: call.id, ok: true, output: texts.join("\n") };
}
