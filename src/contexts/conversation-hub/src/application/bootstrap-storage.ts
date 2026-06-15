import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createAliceStore } from "../adapters/sqlite-conversation-store.js";
import { createTokenUsageStore } from "../../../../platform/storage/src/token-usage-store.js";
import { createFileLogStore } from "../adapters/file-log-store.js";

const path = await import("node:path");

type ApiLogRuntime = {
  hydrateSystemLogs(logs: unknown[]): void;
  hydrateMessageLogs(logs: unknown[]): void;
};

export function createApiStorageRuntime(input: {
  config: { memoryFiles: { root: string } };
  time: CurrentTimeProvider;
  apiLogRuntime: ApiLogRuntime;
}) {
  const store = createAliceStore(path.join(input.config.memoryFiles.root, "alice.sqlite"), {
    time: input.time,
    messageLogDbPath: path.join("logs", "message", "message-logs.sqlite")
  });
  const tokenUsageStore = createTokenUsageStore(path.join("logs", "token_usage", "token-usage.sqlite"), { time: input.time });
  const systemLogStore = createFileLogStore("logs/system", { getTimeZone: () => input.time.timeZone });

  input.apiLogRuntime.hydrateSystemLogs(systemLogStore.listRecent(500));
  input.apiLogRuntime.hydrateMessageLogs(store.listMessageLogs(500));

  return {
    store,
    tokenUsageStore,
    systemLogStore
  };
}
