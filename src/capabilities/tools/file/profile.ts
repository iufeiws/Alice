import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

/**
 * 容器工具名映射:Alice 对外大写名 → Pi 容器小写工具名。
 * 参数协议以容器为准(参数名原样透传,不在此转换)。
 */
export const piFileToolNames: Record<"Read" | "Write" | "Edit", "read" | "write" | "edit"> = {
  Read: "read",
  Write: "write",
  Edit: "edit"
};

export const readTool: ToolDefinition = {
  name: "Read",
  description: "Reads a file. Supports text and images. Use offset/limit to page through large files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read (relative or absolute)." },
      offset: { type: "number", description: "Line number to start reading from (1-indexed)." },
      limit: { type: "number", description: "Maximum number of lines to read." }
    },
    required: ["path"],
    additionalProperties: false
  }
};

export const writeTool: ToolDefinition = {
  name: "Write",
  description: "Writes content to a file, creating or overwriting it. Parent directories are created automatically.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write (relative or absolute)." },
      content: { type: "string", description: "Content to write to the file." }
    },
    required: ["path", "content"],
    additionalProperties: false
  }
};

export const editTool: ToolDefinition = {
  name: "Edit",
  description: "Edits one file with one or more exact-text replacements in a single call. Every edits[].oldText must be unique and non-overlapping in the original file; merge nearby changes into one edit instead of emitting overlapping ones.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit (relative or absolute)." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text to replace; must be unique in the original file." },
            newText: { type: "string", description: "Replacement text." }
          },
          required: ["oldText", "newText"],
          additionalProperties: false
        }
      }
    },
    required: ["path", "edits"],
    additionalProperties: false
  }
};

export const globTool: ToolDefinition = {
  name: "Glob",
  description: "Finds files by glob pattern.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against." },
      path: { type: "string", description: "Optional absolute directory path to search in." }
    },
    required: ["pattern"],
    additionalProperties: false
  }
};
