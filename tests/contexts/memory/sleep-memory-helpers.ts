import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { LLMChatInput, LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import type { StoredConversationMessage } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

export function memoryConfig() {
  return {
    enabled: true,
    baseURL: "https://api.deepseek.com",
    apiKey: "test",
    model: "deepseek-v4-pro",
    temperature: 0.8,
    timeoutMs: 120_000,
    stream: false,
    extraParams: {},
    followupExtraParams: {}
  };
}

export function editToolClient(seen: LLMChatInput[], patches: string[]): LLMClient {
  const files = patches.length >= 3
    ? ["persistent-memory.md", "user-preferences.md", "diary.md"]
    : ["persistent-memory.md"];
  const edits = patches.map((patch, index) => ({ file: files[index] ?? "persistent-memory.md", ...patchToEdit(patch) }));
  return editSequenceClient(seen, edits);
}

export function editSequenceClient(seen: LLMChatInput[], edits: Array<{ file: string; oldString: string; newString: string }>): LLMClient {
  let index = 0;
  let phase: "read" | "edit" | "done" = edits.length > 0 ? "read" : "done";
  return {
    async chat(input) {
      seen.push(input);
      if (phase === "done") {
        return { message: { role: "assistant", content: "done" } };
      }
      const edit = edits[index];
      if (phase === "read") {
        phase = "edit";
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: `read_${index + 1}`,
              type: "function",
              function: {
                name: "Read",
                arguments: JSON.stringify({ file_path: edit.file })
              }
            }]
          }
        };
      }
      index += 1;
      phase = index >= edits.length ? "done" : "read";
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `edit_${index}`,
            type: "function",
            function: {
              name: "Edit",
              arguments: JSON.stringify({ file_path: edit.file, old_string: edit.oldString, new_string: edit.newString })
            }
          }]
        }
      };
    }
  };
}

function patchToEdit(patch: string): { oldString: string; newString: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("---")) continue;
    if (line.startsWith("--")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    }
  }
  return {
    oldString: oldLines.length ? `${oldLines.join("\n")}\n` : "",
    newString: newLines.length ? `${newLines.join("\n")}\n` : ""
  };
}

export function addPatch(content: string): string {
  const lines = content.trimEnd().split("\n");
  return [
    "*** Begin Patch",
    "@@",
    ...lines.map((line) => `+${line}`),
    "*** End Patch"
  ].join("\n");
}

export function replacePatch(from: string, to: string): string {
  const oldLines = from.trimEnd().split("\n");
  const newLines = to.trimEnd().split("\n");
  return [
    "*** Begin Patch",
    "@@",
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "*** End Patch"
  ].join("\n");
}

export function message(createdAt: string, contentText: string): StoredConversationMessage {
  return {
    id: Number(createdAt.replace(/\D/g, "").slice(-8)),
    plugin: "feishu",
    conversationId: "session",
    direction: "inbound",
    senderRole: "user",
    contentType: "text",
    contentText,
    createdAt,
    status: "sent",
    isRead: false,
    isRecalled: false,
    reactionsJson: "{}",
    lastEventAt: createdAt
  };
}

export function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function findSessionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findSessionFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files.sort();
}
