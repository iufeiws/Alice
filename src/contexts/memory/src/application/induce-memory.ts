import type { SleepMemoryInductionConfig } from "../contracts/memory-config.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMRequestSender } from "../../../llm-gateway/src/llm-tool-loop.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import type { BashSandboxConfig, BashSandboxRuntime } from "../../../bash-sandbox/src/index.js";
import type { createAliceStore } from "../../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { DiaryStore } from "../../../../platform/storage/src/diary-store.js";
import {
  createSleepMemoryStateStore,
  runSleepMemoryInduction,
  type MemoryInductionPromptStore,
  type MemoryStore
} from "../memory.js";
import { createLLMClientFromPreset, type LLMApiPreset } from "../../../llm-gateway/src/llm-api-profile.js";

type AliceStore = ReturnType<typeof createAliceStore>;
type SleepMemoryStateStore = ReturnType<typeof createSleepMemoryStateStore>;

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createSleepMemoryInductionRuntime(input: {
  config: SleepMemoryInductionConfig;
  memoryStore: MemoryStore;
  promptStore: MemoryInductionPromptStore;
  promptContextRuntime: PromptContextRuntime;
  sandbox?: {
    config: BashSandboxConfig;
    runtime: BashSandboxRuntime;
  };
  stateStore: SleepMemoryStateStore;
  diaryStore: DiaryStore;
  getMessageStore(): AliceStore | undefined;
  llmRequestSender(): LLMRequestSender;
  resolveMemoryPreset(): LLMApiPreset | undefined;
  time: CurrentTimeProvider;
  sessionRoot(): string;
  sendFailureNotice(): Promise<void>;
  appendLog: AppendLog;
}) {
  let queue: Promise<void> = Promise.resolve();
  let active = false;

  return {
    trigger,
    isActive: () => active
  };

  async function trigger(): Promise<void> {
    queue = queue
      .catch((error) => {
        input.appendLog("warn", `sleep Memorize queue recovered: ${error instanceof Error ? error.message : String(error)}`);
      })
      .then(runQueued);
    return queue;
  }

  async function runQueued(): Promise<void> {
    active = true;
    try {
      const memoryPreset = input.resolveMemoryPreset();
      const memoryConfig = memoryPreset ? {
        ...input.config.memorySummary,
        baseURL: memoryPreset.baseURL,
        apiKey: memoryPreset.apiKey,
        model: memoryPreset.model,
        temperature: memoryPreset.temperature,
        timeoutMs: memoryPreset.timeoutMs,
        stream: memoryPreset.stream,
        extraParams: memoryPreset.extraParams,
        followupExtraParams: memoryPreset.followupExtraParams
      } : { ...input.config.memorySummary, enabled: false, apiKey: undefined };
      const memoryLLM = memoryPreset ? createLLMClientFromPreset(memoryPreset) : undefined;
      const messageStore = input.getMessageStore();
      if (!messageStore) throw new Error("message_store_unavailable");
      const ok = await runSleepMemoryInduction({
        memoryStore: input.memoryStore,
        promptStore: input.promptStore,
        promptContextRuntime: input.promptContextRuntime,
        sandbox: input.sandbox,
        stateStore: input.stateStore,
        diaryStore: input.diaryStore,
        messageStore,
        llm: memoryLLM,
        llmRequestSender: input.llmRequestSender(),
        config: memoryConfig,
        nowIso: () => input.time.now().iso,
        timezone: input.time.timeZone,
        sessionRoot: input.sessionRoot(),
        log: input.appendLog
      });
      if (!ok) await input.sendFailureNotice();
    } catch (error) {
      input.appendLog("error", `sleep Memorize failed: ${error instanceof Error ? error.message : String(error)}`);
      await input.sendFailureNotice();
    } finally {
      active = false;
    }
  }
}
