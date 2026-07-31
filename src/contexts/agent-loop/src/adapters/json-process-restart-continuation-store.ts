import type { AgentEvent } from "../contracts/agent-contracts.js";
import type { LLMToolLoopContinuation } from "../../../llm-gateway/src/llm-tool-loop.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type ProcessRestartContinuationRecord = {
  version: 1;
  sessionId: number;
  toolCallId: string;
  restartCompleted: boolean;
  event: AgentEvent;
  continuation: LLMToolLoopContinuation;
  createdAt: string;
};

export type ProcessRestartContinuationStore = {
  read(): ProcessRestartContinuationRecord | undefined;
  save(record: ProcessRestartContinuationRecord): void;
  clear(toolCallId: string): boolean;
};

export function createJsonProcessRestartContinuationStore(filePath: string): ProcessRestartContinuationStore {
  return {
    read() {
      if (!fs.existsSync(filePath)) return undefined;
      return parseRecord(JSON.parse(fs.readFileSync(filePath, "utf8")));
    },
    save(record) {
      const normalized = parseRecord(record);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized)}\n`);
      fs.renameSync(temporaryPath, filePath);
    },
    clear(toolCallId) {
      const current = this.read();
      if (!current || current.toolCallId !== toolCallId) return false;
      fs.unlinkSync(filePath);
      return true;
    }
  };
}

function parseRecord(value: unknown): ProcessRestartContinuationRecord {
  if (!value || typeof value !== "object") throw new Error("process_restart_continuation_invalid");
  const record = value as Partial<ProcessRestartContinuationRecord>;
  if (record.version !== 1
    || !Number.isFinite(record.sessionId)
    || typeof record.toolCallId !== "string"
    || typeof record.restartCompleted !== "boolean"
    || !record.event
    || typeof record.event !== "object"
    || !record.continuation
    || typeof record.continuation !== "object"
    || record.continuation.version !== 1
    || typeof record.createdAt !== "string") {
    throw new Error("process_restart_continuation_invalid");
  }
  return record as ProcessRestartContinuationRecord;
}
