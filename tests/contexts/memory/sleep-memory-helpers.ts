import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { StoredConversationMessage } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { PiWorkerRuntime } from "../../../src/contexts/pi-worker/src/index.js";
import type { MemorySandbox } from "../../../src/contexts/memory/src/model.js";
import { createMemoryInductionPromptStore } from "../../../src/contexts/memory/src/memory.js";

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

export function createTestMemoryPromptStore(root: string) {
  const store = createMemoryInductionPromptStore(path.join(root, "prompts.json"));
  store.save({
    meta: {},
    messages: [{ meta: { title: "Test", enabled: true }, role: "user", content: "" }]
  });
  return store;
}

/**
 * Pi-backed memory sandbox fake. `executeTool` maps container paths under
 * `containerRoot` to `hostRoot` so host reads/writes mimic the shared mount.
 */
export function makeMemorySandbox(root: string): MemorySandbox {
  const hostRoot = path.join(root, "sandbox", "workspace");
  const containerRoot = "/home/alice";
  fs.mkdirSync(hostRoot, { recursive: true });

  const hostPathFor = (containerPath: string): string => {
    if (containerPath.startsWith(containerRoot)) {
      return path.join(hostRoot, containerPath.slice(containerRoot.length).replace(/^\/+/, ""));
    }
    return path.join(hostRoot, containerPath.replace(/^\/+/, ""));
  };

  const runtime: PiWorkerRuntime = {
    async start() {},
    async stop() {},
    async refresh() {},
    async wakeIfNeeded() {},
    async health() {
      throw new Error("health is not available in memory sandbox tests");
    },
    async previewPrompt() {
      return { sessionId: "preview", systemPrompt: "preview" };
    },
    toolDefinitions() {
      return [
        { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } } } },
        { name: "edit", description: "Edit a file", inputSchema: { type: "object", properties: { path: { type: "string" }, edits: { type: "array" } } } },
        { name: "bash", description: "bash", inputSchema: { type: "object" } },
        { name: "write", description: "write", inputSchema: { type: "object" } }
      ];
    },
    async executeTool({ toolName, input }) {
      const containerPath = typeof input?.path === "string" ? input.path : "";
      const hostPath = hostPathFor(containerPath);
      if (toolName === "read") {
        const content = fs.existsSync(hostPath) ? fs.readFileSync(hostPath, "utf8") : "";
        return { ok: true, output: content };
      }
      if (toolName === "edit") {
        const content = fs.existsSync(hostPath) ? fs.readFileSync(hostPath, "utf8") : "";
        let next = content;
        for (const edit of Array.isArray(input?.edits) ? input.edits : []) {
          const oldText = (edit as { oldText?: unknown })?.oldText;
          const newText = (edit as { newText?: unknown })?.newText;
          if (typeof oldText === "string" && next.includes(oldText)) {
            next = next.replace(oldText, typeof newText === "string" ? newText : "");
          }
        }
        fs.mkdirSync(path.dirname(hostPath), { recursive: true });
        fs.writeFileSync(hostPath, next);
        return { ok: true, output: "OK" };
      }
      throw new Error(`memory tests must not execute tool: ${toolName}`);
    },
    async startSubAgent() {
      throw new Error("subagent is not available in memory sandbox tests");
    },
    async listSubAgents() {
      return [];
    },
    async messagesSubAgent() {
      throw new Error("subagent is not available in memory sandbox tests");
    },
    async sendSubAgent() {
      throw new Error("subagent is not available in memory sandbox tests");
    },
    async statusSubAgent() {
      throw new Error("subagent is not available in memory sandbox tests");
    },
    async waitSubAgent() {
      throw new Error("subagent is not available in memory sandbox tests");
    },
    async cancelSubAgent() {
      throw new Error("subagent is not available in memory sandbox tests");
    },
    async forkSubAgent() {
      throw new Error("subagent is not available in memory sandbox tests");
    },
    onInvocationCompleted() {
      return () => {};
    }
  };
  return { runtime, containerRoot, hostRoot };
}
