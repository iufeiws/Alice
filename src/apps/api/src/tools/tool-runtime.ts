import type { AppConfig } from "../../../../packages/config/src/index.js";
import type { CurrentTimeProvider } from "../../../../core/time/src/index.js";
import { createMessagingTools } from "../../../../tools/messaging/src/index.js";
import { createPhotoTools } from "../../../../tools/photo/src/index.js";
import { createShellTools } from "../../../../tools/shell/src/index.js";
import { createBookcaseTools } from "../../../../tools/bookcase/src/index.js";
import { createSleepCocoonTools } from "../../../../tools/sleep-cocoon/src/index.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;
type AppendMessageLog = (input: any) => unknown;

export function createToolRuntime(input: {
  config: AppConfig;
  store: any;
  outputRouter: any;
  time: CurrentTimeProvider;
  voiceSynthesizer: any;
  promptProfileStore: any;
  dailyShellStore: any;
  diaryStore: any;
  coreProfileStore: any;
  agentState: any;
  getDefaultTarget(): any;
  appendLog: AppendLog;
  appendMessageLog: AppendMessageLog;
}) {
  const messagingTools = createMessagingTools({
    store: input.store,
    outputRouter: input.outputRouter,
    time: input.time,
    voiceSynthesizer: input.voiceSynthesizer,
    getUserName: () => input.promptProfileStore.get().userName,
    getShellSwitchLogs: () => input.dailyShellStore.listSwitchLogs(500),
    getSleepCocoonEnteredAt: () => input.diaryStore.listSleepBoundaries().at(-1)?.occurredAt,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    appendMessageLog: input.appendMessageLog,
    appendLog: input.appendLog
  });

  const photoConfigPath = "config/plugin/photo/config.json";
  const photoTools = createPhotoTools({
    store: input.store,
    outputRouter: input.outputRouter,
    time: input.time,
    selfieConfigPath: photoConfigPath,
    selfieReferenceDir: input.config.photo.selfieReferenceDir,
    selfieOutputDir: input.config.photo.selfieOutputDir,
    selfieCodexCommand: input.config.photo.selfieCodexCommand,
    selfieCodexTimeoutMs: input.config.photo.selfieCodexTimeoutMs,
    selfieImageApiKey: input.config.photo.selfieImageApiKey,
    selfieImageApiBaseURL: input.config.photo.selfieImageApiBaseURL,
    selfieImageApiModel: input.config.photo.selfieImageApiModel,
    selfieImageApiSize: input.config.photo.selfieImageApiSize,
    selfieImageApiQuality: input.config.photo.selfieImageApiQuality,
    selfieImageApiOutputFormat: input.config.photo.selfieImageApiOutputFormat,
    selfieImageApiOutputCompression: input.config.photo.selfieImageApiOutputCompression,
    selfieImageApiTimeoutMs: input.config.photo.selfieImageApiTimeoutMs,
    selfieMaxBytes: input.config.photo.selfieMaxBytes,
    getSelfieContext() {
      const daily = input.dailyShellStore.get(input.time.now().date, input.time.timeZone);
      const profile = input.promptProfileStore.get();
      return {
        mainPrompt: profile.layers.map((layer: any) => layer.content).join("\n\n"),
        personalityName: daily.personality.name,
        personalityContent: daily.personality.content,
        outfitId: daily.outfit.id,
        outfitName: daily.outfit.name,
        outfitContent: daily.outfit.content,
        outfitImageUrl: daily.outfit.imageUrl
      };
    },
    getUserName: () => input.promptProfileStore.get().userName,
    getAppearanceDescription: () => input.coreProfileStore.get().appearanceDescription,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });

  const shellTools = createShellTools({
    dailyShellStore: input.dailyShellStore,
    store: input.store,
    outputRouter: input.outputRouter,
    time: input.time,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    appendMessageLog: input.appendMessageLog
  });

  const bookcaseTools = createBookcaseTools({
    getUserName: () => input.promptProfileStore.get().userName,
    time: input.time,
    store: input.store,
    outputRouter: input.outputRouter,
    appendMessageLog: input.appendMessageLog
  });

  const sleepCocoonTools = createSleepCocoonTools({
    agentState: input.agentState,
    time: input.time,
    outputRouter: input.outputRouter,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    appendLog: input.appendLog
  });

  return {
    messagingTools,
    photoConfigPath,
    photoTools,
    shellTools,
    bookcaseTools,
    sleepCocoonTools,
    toolPlugins: [messagingTools, photoTools, shellTools, bookcaseTools, sleepCocoonTools]
  };
}
