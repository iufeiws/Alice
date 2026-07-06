import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const readTool: ToolDefinition = {
  name: "Read",
  description: "Reads a file by absolute path. This tool can read text and images (eg PNG, JPG, etc). ",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to read." },
      offset: { type: "number", description: "Optional 1-based line number to start reading from." },
      limit: { type: "number", description: "Optional number of lines to read." }
    },
    required: ["file_path"],
    additionalProperties: false
  }
};

export const editTool: ToolDefinition = {
  name: "Edit",
  description: "Performs exact string replacements in a file.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to modify." },
      old_string: { type: "string", description: "The text to replace." },
      new_string: { type: "string", description: "The text to replace it with." },
      replace_all: { type: "boolean", description: "Replace all occurrences of old_string." }
    },
    required: ["file_path", "old_string", "new_string"],
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

export const grepTool: ToolDefinition = {
  name: "Grep",
  description: "Searches file contents with ripgrep.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression pattern to search for in file contents." },
      path: { type: "string", description: "Optional absolute file or directory path to search in." },
      glob: { type: "string", description: "Optional glob pattern to filter files." },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output mode. Defaults to files_with_matches." },
      "-B": { type: "number", description: "Number of lines to show before each match for content output." },
      "-A": { type: "number", description: "Number of lines to show after each match for content output." },
      "-C": { type: "number", description: "Alias for context." },
      context: { type: "number", description: "Number of lines to show before and after each match for content output." },
      "-n": { type: "boolean", description: "Show line numbers in content output. Defaults to true." },
      "-i": { type: "boolean", description: "Case insensitive search." },
      type: { type: "string", description: "Ripgrep file type filter." },
      head_limit: { type: "number", description: "Limit output to first N lines or entries. Defaults to 250; pass 0 for unlimited." },
      offset: { type: "number", description: "Skip first N lines or entries before applying head_limit." },
      multiline: { type: "boolean", description: "Enable multiline mode." }
    },
    required: ["pattern"],
    additionalProperties: false
  }
};
