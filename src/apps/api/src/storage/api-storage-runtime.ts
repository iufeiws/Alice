import type { AppConfig } from "../../../../packages/config/src/index.js";
import type { CurrentTimeProvider } from "../../../../core/time/src/index.js";
import { createAliceStore } from "../../../../packages/storage/src/sqlite-store.js";
import { createTokenUsageStore } from "../../../../packages/storage/src/token-usage-store.js";
import { createFileLogStore } from "../../../../packages/storage/src/file-log-store.js";
import type { createApiLogRuntime } from "../bootstrap/api-log-runtime.js";

const path = await import("node:path");

type ApiLogRuntime = ReturnType<typeof createApiLogRuntime>;

export function createApiStorageRuntime(input: {
  config: AppConfig;
  time: CurrentTimeProvider;
  apiLogRuntime: ApiLogRuntime;
}) {
  const store = createAliceStore("data/alice.sqlite", {
    time: input.time,
    messageDbPath: path.join(input.config.memoryFiles.root, "message", "messages.sqlite"),
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
