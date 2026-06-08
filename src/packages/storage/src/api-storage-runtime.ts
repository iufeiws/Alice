import type { AppConfig } from "../../config/src/index.js";
import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import { createAliceStore } from "./sqlite-store.js";
import { createTokenUsageStore } from "./token-usage-store.js";
import { createFileLogStore } from "./file-log-store.js";
import type { createApiLogRuntime } from "../../../apps/api/bootstrap/api-log-runtime.js";

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
