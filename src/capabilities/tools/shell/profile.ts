import type { ToolDefinition } from "../../../contexts/tool-execution/src/index.js";

/** Alice 对外大写名 → Pi 容器小写工具名。参数协议以容器为准。 */
export const bashToolName = "Bash";
export const bashPiToolName = "bash";

export const bashTool: ToolDefinition = {
  name: bashToolName,
  description: "Executes a bash command in the sandbox working directory. Optionally provide timeout in seconds.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute." },
      timeout: { type: "number", description: "Timeout in seconds." }
    },
    required: ["command"],
    additionalProperties: false
  }
};
