import { createSleepMemoryInductionRuntime } from "../sleep-memory-induction-runtime.js";

export function createSleepMemoryBridgeRuntime(input: {
  config: any;
  memoryStore: any;
  promptStore: any;
  stateStore: any;
  diaryStore: any;
  getMessageStore(): any;
  getLLMRequestSender(): any;
  resolveMemoryPreset(): any;
  time: any;
  sessionRoot(): string;
  sendFailureNotice(): Promise<void>;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  return createSleepMemoryInductionRuntime({
    config: input.config,
    memoryStore: input.memoryStore,
    promptStore: input.promptStore,
    stateStore: input.stateStore,
    diaryStore: input.diaryStore,
    getMessageStore: input.getMessageStore,
    llmRequestSender: input.getLLMRequestSender,
    resolveMemoryPreset: input.resolveMemoryPreset,
    time: input.time,
    sessionRoot: input.sessionRoot,
    sendFailureNotice: input.sendFailureNotice,
    appendLog: input.appendLog
  });
}
