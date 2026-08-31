import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ToolPlugin } from "../../../../contexts/tool-execution/src/index.js";
import { createMessagingTools, defaultMessagingPluginConfigPath, readMessagingPluginConfig } from "./index.js";
import { createPhotoTools } from "../../photo/src/index.js";
import { createWardrobeTools } from "../../wardrobe/src/index.js";
import { createBookcaseTools } from "../../bookcase/src/index.js";
import { createSleepCocoonTools } from "../../sleep-cocoon/src/index.js";
import { createLocationTools } from "../../location/src/index.js";
import { createCalendarTools } from "../../calendar/src/index.js";
import { createFinishAndWaitTools } from "../../finish-and-wait/src/index.js";
import { createDiceTools } from "../../dice/src/index.js";
import { createFileTools } from "../../file/src/index.js";
import { createShellTools } from "../../shell/src/index.js";
import { createSkillsTools } from "../../skills/src/index.js";
import { createRestartTools, createSystemdRestartController } from "../../restart/src/index.js";
import { createToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import { createOutfitOnBodyGenerationAttempt } from "../../../../contexts/capabilities/src/outfit-on-body-runtime.js";
import { createBashSandboxRuntime } from "../../../../contexts/bash-sandbox/src/index.js";
import { createSkillLoader, type SkillRegistry } from "../../../../contexts/skills/src/index.js";
import { defaultWorldWandererPluginConfigPath } from "../../../../contexts/world-wanderer/src/index.js";
import type { GoogleStreetViewPlugin } from "../../../../channels/google-streetview/src/index.js";
import type { ImageRecognitionTarget } from "../../../../channels/image-recognition/src/index.js";
import type { PromptContextRuntime } from "../../../../contexts/prompt-context/src/index.js";
import type { ShortMemoryStore } from "../../../../contexts/memory/src/short-memory-store.js";
import { createRandomEventSandboxRuntime } from "../../../../contexts/initiative/src/application/random-event-sandbox-runtime.js";
import type { PiWorkerRuntime } from "../../../../contexts/pi-worker/src/index.js";
import { createSubAgentTool } from "../../subagent/src/index.js";

const path = await import("node:path");

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;
type AppendMessageLog = (input: any) => unknown;

export function createToolRuntime(input: {
  config: { project: { username: string }; photo: any; tts?: any; memoryFiles?: { root?: string }; skills?: { root?: string; installedRoot?: string }; bashSandbox: any };
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
  getGoogleStreetView(): Pick<GoogleStreetViewPlugin, "getPanoGraphByCoordinates" | "getPanoGraphByPanoId" | "getStreetViewByCoordinates">;
  getWorldWandererStreetViewReferenceImage?(): Promise<string | undefined> | string | undefined;
  skillsRegistry: SkillRegistry;
  promptContextRuntime: PromptContextRuntime;
  shortMemoryStore: Pick<ShortMemoryStore, "listLatest">;
  randomEventStore: any;
  getApprovalService(): any;
  onMessagesPolled?(sessionId: string): void;
  appendLog: AppendLog;
  appendMessageLog: AppendMessageLog;
  piWorkerRuntime?: PiWorkerRuntime;
  recognizeImage?(target: ImageRecognitionTarget): Promise<{ text: string }>;
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
    bashSandbox: input.config.bashSandbox,
    getUserName: () => input.config.project.username,
    getShellSwitchLogs: () => input.dailyShellStore.listSwitchLogs(500),
    getSleepCocoonEnteredAt: () => input.diaryStore.listSleepBoundaries().at(-1)?.occurredAt,
    getLatestShortMemoryCreatedAtUtc: () => input.shortMemoryStore.listLatest(1)[0]?.createdAtUtc,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    onMessagesPolled: input.onMessagesPolled,
    resolveOutputTarget,
    appendMessageLog: input.appendMessageLog,
    appendLog: input.appendLog
  });

  const photoConfigPath = "config/plugin/photo/config.json";
  const bashRuntime = createBashSandboxRuntime({ config: input.config.bashSandbox });
  const attemptOnBodyGeneration = createOutfitOnBodyGenerationAttempt({
    config: input.config,
    dailyShellStore: input.dailyShellStore,
    time: input.time,
    promptProfileStore: input.promptProfileStore,
    coreProfileStore: input.coreProfileStore,
    promptContextRuntime: input.promptContextRuntime,
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
    selfieCodexExtraPrompt: input.config.photo.selfieCodexExtraPrompt,
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
    selfieXaiImageApiKey: input.config.photo.selfieXaiImageApiKey,
    selfieXaiImageApiBaseURL: input.config.photo.selfieXaiImageApiBaseURL,
    selfieXaiImageApiModel: input.config.photo.selfieXaiImageApiModel,
    selfieXaiImageApiAspectRatio: input.config.photo.selfieXaiImageApiAspectRatio,
    selfieXaiImageApiResolution: input.config.photo.selfieXaiImageApiResolution,
    selfieXaiImageApiQuality: input.config.photo.selfieXaiImageApiQuality,
    selfieXaiImageApiTimeoutMs: input.config.photo.selfieXaiImageApiTimeoutMs,
    selfieMaxBytes: input.config.photo.selfieMaxBytes,
    selfie2DinRealEnabled: input.config.photo.selfie2DinRealEnabled,
    selfie2DinRealReferenceImage: input.config.photo.selfie2DinRealReferenceImage,
    selfie2DinRealPrompt: input.config.photo.selfie2DinRealPrompt,
    promptContextRuntime: input.promptContextRuntime,
    getWorldWandererStreetViewReferenceImage: input.getWorldWandererStreetViewReferenceImage,
    getSelfieContext() {
      const daily = input.dailyShellStore.get(input.time.now().date, input.time.timeZone);
      return {
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
    getUserName: () => input.config.project.username,
    getAppearanceDescription: () => input.coreProfileStore.get().appearanceDescription,
    getDefaultTarget() {
      return input.getDefaultTarget();
    },
    resolveOutputTarget,
    mountGeneratedSelfieInSandbox(mount) {
      const next = { id: "generated_selfie", readOnly: true, ...mount };
      const existing = input.config.bashSandbox.mounts.findIndex((entry: any) => entry.id === next.id);
      if (existing >= 0) input.config.bashSandbox.mounts[existing] = next;
      else input.config.bashSandbox.mounts.push(next);
    },
    appendLog: input.appendLog,
    appendMessageLog: input.appendMessageLog
  });

  const wardrobeTools = createWardrobeTools({
    wardrobeRuntime: input.dailyShellStore,
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
    getUserName: () => input.config.project.username,
    promptContextRuntime: input.promptContextRuntime,
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
    store: input.store,
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
  const finishAndWaitTools = createFinishAndWaitTools({ agentState: input.agentState });
  const diceTools = createDiceTools();
  const locationTools = createLocationTools({
    configPath: defaultWorldWandererPluginConfigPath,
    dbPath: path.join(input.config.memoryFiles?.root ?? "memory-files", "alice.sqlite"),
    getGoogleStreetView: input.getGoogleStreetView,
    now: () => input.time.now().iso,
    time: input.time,
    store: input.store,
    outputRouter: input.outputRouter,
    resolveOutputTarget,
    appendMessageLog: input.appendMessageLog
  });
  const randomEventSandbox = createRandomEventSandboxRuntime({
    store: input.randomEventStore,
    hostWorkspaceRoot: input.config.bashSandbox.hostWorkspaceDir,
    sandbox: bashRuntime,
    getApprovalService: input.getApprovalService
  });
  const skillsLoader = createSkillLoader(
    input.skillsRegistry,
    bashRuntime,
    (skill) => randomEventSandbox.prepareSkill(skill),
    (name) => {
      const value = input.promptContextRuntime.getVariable(name);
      return typeof value === "string" ? value : undefined;
    }
  );
  const skillsTools = createSkillsTools({ loader: skillsLoader });
  const fileTools = createFileTools({
    bashSandbox: bashRuntime,
    config: input.config.bashSandbox,
    piWorker: input.piWorkerRuntime,
    recognizeImage: input.recognizeImage
  });
  const shellTools = input.piWorkerRuntime ? createShellTools({ runtime: input.piWorkerRuntime }) : undefined;
  const subAgentTools = input.piWorkerRuntime ? createSubAgentTool({
    runtime: input.piWorkerRuntime,
    resolveOutputTarget,
    agentState: input.agentState,
    getRegisteredMessageChannels: () => input.outputRouter.listChannels()
  }) : undefined;
  const restartTools = createRestartTools(createSystemdRestartController());

  const toolPlugins = [messagingTools, finishAndWaitTools, restartTools, photoTools, wardrobeTools, bookcaseTools, sleepCocoonTools, calendarTools, diceTools, locationTools, fileTools, skillsTools, shellTools, subAgentTools].filter(Boolean) as ToolPlugin[];

  return {
    messagingTools,
    photoConfigPath,
    photoTools,
    wardrobeTools,
    bookcaseTools,
    sleepCocoonTools,
    calendarTools,
    finishAndWaitTools,
    restartTools,
    diceTools,
    locationTools,
    fileTools,
    shellTools,
    subAgentTools,
    bashRuntime,
    skillsTools,
    skillsRegistry: input.skillsRegistry,
    skillsLoader,
    toolPlugins
  };
}
