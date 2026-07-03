import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createMessagingTools, defaultMessagingPluginConfigPath, readMessagingPluginConfig } from "./index.js";
import { createPhotoTools } from "../../photo/src/index.js";
import { createShellTools } from "../../shell/src/index.js";
import { createBookcaseTools } from "../../bookcase/src/index.js";
import { createSleepCocoonTools } from "../../sleep-cocoon/src/index.js";
import { createLocationTools } from "../../location/src/index.js";
import { createCalendarTools } from "../../calendar/src/index.js";
import { createFinishAndWaitTools } from "../../finish-and-wait/src/index.js";
import { createDiceTools } from "../../dice/src/index.js";
import { createBashTools } from "../../bash/src/index.js";
import { createSkillsTools } from "../../skills/src/index.js";
import { createToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import { createOutfitOnBodyGenerationAttempt } from "../../../../contexts/capabilities/src/outfit-on-body-runtime.js";
import { createBashSandboxRuntime } from "../../../../contexts/bash-sandbox/src/index.js";
import { createSkillLoader, type SkillRegistry } from "../../../../contexts/skills/src/index.js";
import { defaultWorldWandererPluginConfigPath } from "../../../../contexts/world-wanderer/src/index.js";
import type { GoogleStreetViewPlugin } from "../../../../channels/google-streetview/src/index.js";

const path = await import("node:path");

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;
type AppendMessageLog = (input: any) => unknown;

export function createToolRuntime(input: {
  config: { photo: any; tts?: any; memoryFiles?: { root?: string }; skills?: { root?: string; installedRoot?: string }; bashSandbox: any };
  store: any;
  outputRouter: any;
  time: CurrentTimeProvider;
  voiceSynthesizer: any;
  promptProfileStore: any;
  dailyShellStore: any;
  diaryStore: any;
  calendarStore: any;
  coreProfileStore: any;
  agentState: any;
  getDefaultTarget(): any;
  getGoogleStreetView(): Pick<GoogleStreetViewPlugin, "getPanoGraphByCoordinates" | "getPanoGraphByPanoId">;
  getWorldWandererStreetViewReferenceImage?(): Promise<string | undefined> | string | undefined;
  skillsRegistry: SkillRegistry;
  appendLog: AppendLog;
  appendMessageLog: AppendMessageLog;
}) {
  const resolveOutputTarget = createToolOutputTargetResolver({
    getDefaultTarget() {
      return input.getDefaultTarget();
    }
  });
  const messagingTools = createMessagingTools({
    store: input.store,
    outputRouter: input.outputRouter,
    time: input.time,
    voiceSynthesizer: input.voiceSynthesizer,
    voiceMessageTtsTrainingOutputDir: input.config.tts?.voiceMessageTrainingOutputDir,
    wechatVoiceFallbackToText: input.config.tts?.wechatVoiceFallbackToText,
    config: () => readMessagingPluginConfig(defaultMessagingPluginConfigPath),
    getUserName: () => input.promptProfileStore.get().userName,
    getShellSwitchLogs: () => input.dailyShellStore.listSwitchLogs(500),
    getSleepCocoonEnteredAt: () => input.diaryStore.listSleepBoundaries().at(-1)?.occurredAt,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    resolveOutputTarget,
    appendMessageLog: input.appendMessageLog,
    appendLog: input.appendLog
  });

  const photoConfigPath = "config/plugin/photo/config.json";
  const attemptOnBodyGeneration = createOutfitOnBodyGenerationAttempt({
    config: input.config,
    dailyShellStore: input.dailyShellStore,
    time: input.time,
    promptProfileStore: input.promptProfileStore,
    coreProfileStore: input.coreProfileStore,
    photoConfigPath,
    appendLog: input.appendLog
  });
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
    selfieImageApiRelayKey: input.config.photo.selfieImageApiRelayKey,
    selfieImageApiRelayBaseURL: input.config.photo.selfieImageApiRelayBaseURL,
    selfieImageApiModel: input.config.photo.selfieImageApiModel,
    selfieImageApiSize: input.config.photo.selfieImageApiSize,
    selfieImageApiQuality: input.config.photo.selfieImageApiQuality,
    selfieImageApiModeration: input.config.photo.selfieImageApiModeration,
    selfieImageApiOutputFormat: input.config.photo.selfieImageApiOutputFormat,
    selfieImageApiOutputCompression: input.config.photo.selfieImageApiOutputCompression,
    selfieImageApiTimeoutMs: input.config.photo.selfieImageApiTimeoutMs,
    selfieImageApiRelayModel: input.config.photo.selfieImageApiRelayModel,
    selfieImageApiRelaySize: input.config.photo.selfieImageApiRelaySize,
    selfieImageApiRelayQuality: input.config.photo.selfieImageApiRelayQuality,
    selfieImageApiRelayModeration: input.config.photo.selfieImageApiRelayModeration,
    selfieImageApiRelayOutputFormat: input.config.photo.selfieImageApiRelayOutputFormat,
    selfieImageApiRelayOutputCompression: input.config.photo.selfieImageApiRelayOutputCompression,
    selfieImageApiRelayTimeoutMs: input.config.photo.selfieImageApiRelayTimeoutMs,
    selfieMaxBytes: input.config.photo.selfieMaxBytes,
    selfie2DinRealEnabled: input.config.photo.selfie2DinRealEnabled,
    selfie2DinRealReferenceImage: input.config.photo.selfie2DinRealReferenceImage,
    selfie2DinRealPrompt: input.config.photo.selfie2DinRealPrompt,
    getWorldWandererStreetViewReferenceImage: input.getWorldWandererStreetViewReferenceImage,
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
        outfitImageUrl: daily.outfit.imageUrl,
        onBodyImageUrl: daily.outfit.onBodyImageUrl,
        outfitImageGenerated: daily.outfit.outfitImageGenerated,
        onBodyGenerationAttempted: daily.outfit.onBodyGenerationAttempted
      };
    },
    getUserName: () => input.promptProfileStore.get().userName,
    getAppearanceDescription: () => input.coreProfileStore.get().appearanceDescription,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    resolveOutputTarget,
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });

  const shellTools = createShellTools({
    dailyShellStore: input.dailyShellStore,
    store: input.store,
    outputRouter: input.outputRouter,
    time: input.time,
    attemptOnBodyGeneration,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    resolveOutputTarget,
    appendMessageLog: input.appendMessageLog
  });

  const bookcaseTools = createBookcaseTools({
    getUserName: () => input.promptProfileStore.get().userName,
    time: input.time,
    store: input.store,
    outputRouter: input.outputRouter,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    resolveOutputTarget,
    appendMessageLog: input.appendMessageLog
  });

  const sleepCocoonTools = createSleepCocoonTools({
    agentState: input.agentState,
    time: input.time,
    outputRouter: input.outputRouter,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    resolveOutputTarget,
    appendLog: input.appendLog
  });
  const calendarTools = createCalendarTools({
    calendarStore: input.calendarStore,
    time: input.time
  });
  const finishAndWaitTools = createFinishAndWaitTools();
  const diceTools = createDiceTools();
  const locationTools = createLocationTools({
    configPath: defaultWorldWandererPluginConfigPath,
    dbPath: path.join(input.config.memoryFiles?.root ?? "memory-files", "alice.sqlite"),
    getGoogleStreetView: input.getGoogleStreetView,
    now: () => input.time.now().date
  });
  const bashRuntime = createBashSandboxRuntime({ config: input.config.bashSandbox });
  const skillsLoader = createSkillLoader(input.skillsRegistry, bashRuntime);
  const skillsTools = createSkillsTools({ loader: skillsLoader });
  const bashTools = createBashTools({
    runtime: bashRuntime
  });

  const toolPlugins = [messagingTools, finishAndWaitTools, photoTools, shellTools, bookcaseTools, sleepCocoonTools, calendarTools, diceTools, locationTools, skillsTools, bashTools];

  return {
    messagingTools,
    photoConfigPath,
    photoTools,
    shellTools,
    bookcaseTools,
    sleepCocoonTools,
    calendarTools,
    finishAndWaitTools,
    diceTools,
    locationTools,
    bashTools,
    bashRuntime,
    skillsTools,
    skillsRegistry: input.skillsRegistry,
    skillsLoader,
    toolPlugins
  };
}
