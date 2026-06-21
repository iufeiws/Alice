import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const readTool: ToolDefinition = {
  name: "Read",
  description: [
    "Reads a file from the local workspace.",
    "The file_path parameter must be a workspace-relative path.",
    "Returns content with cat -n style line numbers. Use offset and limit to page through large files."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Workspace-relative path to the file to read." },
      offset: { type: "number", description: "Optional 1-based line number to start reading from." },
      limit: { type: "number", description: "Optional maximum number of lines to read." }
    },
    required: ["file_path"],
    additionalProperties: false
  }
};

export const editTool: ToolDefinition = {
  name: "Edit",
  description: [
    "Performs exact string replacements in a workspace file.",
    "The file must have been read with Read in this session before editing.",
    "old_string must match exactly. By default it must match exactly once; use replace_all only when every match should be replaced."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Workspace-relative path to the file to modify." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace all occurrences of old_string." }
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false
  }
};

export const globTool: ToolDefinition = {
  name: "Glob",
  description: [
    "Finds workspace files by glob pattern.",
    "Supports ** for recursive matching. Results are sorted by modification time descending."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern such as **/*.ts." },
      path: { type: "string", description: "Optional workspace-relative directory path to search from." }
    },
    required: ["pattern"],
    additionalProperties: false
  }
};

export const grepTool: ToolDefinition = {
  name: "Grep",
  description: [
    "Searches file contents in the workspace using ripgrep.",
    "Defaults to files_with_matches. Use output_mode=content for matching lines or output_mode=count for per-file counts."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern to search for." },
      path: { type: "string", description: "Optional workspace-relative file or directory path to search." },
      glob: { type: "string", description: "Optional glob filter passed to ripgrep." },
      type: { type: "string", description: "Optional ripgrep file type filter, such as ts or js." },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"], default: "files_with_matches" },
      multiline: { type: "boolean", description: "Enable ripgrep multiline mode." }
    },
    required: ["pattern"],
    additionalProperties: false
  }
};

export const workspaceFilesToolText = {
  unknownTool: (toolName: string) => `Unknown workspace file tool: ${toolName}`,
  readBeforeEdit: "File must be read with Read before Edit",
  changedSinceRead: "File has changed since it was last read",
  emptyOldString: "old_string can be empty only when editing an empty file",
  ambiguousOldString: (matches: number) => `old_string appears ${matches} times; include more surrounding context to identify one occurrence or use replace_all to replace every occurrence`,
  updated: (filePath: string) => `The file ${filePath} has been updated.`,
  pathMustBeDirectory: "path must be a directory inside the workspace",
  noFilesFound: "No files found",
  unsupportedOutputMode: "unsupported output_mode",
  rgFailed: (message: string) => `rg failed: ${message}`,
  rgExited: (status: number | null) => `rg exited with status ${status}`,
  noMatchesFound: "No matches found",
  fileIsEmpty: "File is empty.",
  fileNotFound: "file not found",
  pathMustPointToFile: "path must point to a file",
  noLinesFound: (offset: number, lineCount: number) => `No lines found at offset ${offset}. File has ${lineCount} line(s).`,
  showingLines: (offset: number, end: number, lineCount: number, next: number) => `[Showing lines ${offset}-${end} of ${lineCount}. Use offset=${next} to continue.]`,
  pathWorkspaceRelative: "path must be workspace-relative",
  pathOutsideWorkspace: "path is outside the workspace",
  required: (name: string) => `${name} is required`,
  oldStringNotFound: "old_string not found in file",
  lineEndingMismatch: "possible line ending mismatch: old_string differs only after CRLF/LF normalization",
  whitespaceMismatch: "possible whitespace mismatch: check leading, trailing, or line-end spaces in old_string",
  whitespaceNormalizedMatch: "possible whitespace-normalized match: spacing or indentation differs from the file",
  unicodeNormalizationMismatch: "possible Unicode normalization mismatch: old_string matches after NFC normalization",
  noEditApplied: "No edit was applied. Re-read the file and provide an exact old_string with enough surrounding context."
};
