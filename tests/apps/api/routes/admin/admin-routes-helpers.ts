import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApiRequestHandler } from "../../../../../src/apps/api/routes/admin-routes.js";
import { createAdminRouteServices } from "../../../../../src/apps/api/bootstrap/admin-api-service.js";
import {
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  runMemoryInductionForMessages
} from "../../../../../src/contexts/memory/src/memory.js";
import { promptStoragePath } from "../../../../../src/contexts/agent-profile/src/adapters/json-prompt-profile-store.js";
import { createPromptProfileStore } from "../../../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createDailyShellStore } from "../../../../../src/contexts/agent-profile/src/domain/shell.js";
import { createPromptContextRuntime, promptVariableTree } from "../../../../../src/contexts/prompt-context/src/index.js";
import type { LLMChatInput, LLMClient } from "../../../../../src/contexts/llm-gateway/src/index.js";
import { createDiaryStore } from "../../../../../src/platform/storage/src/diary-store.js";
import { createCalendarStore } from "../../../../../src/platform/storage/src/calendar-store.js";
import type { StoredConversationMessage } from "../../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";

export const fs = await import("node:fs");
export const path = await import("node:path");
const os = await import("node:os");
export {
  createCalendarStore,
  createDailyShellStore,
  createDiaryStore,
  createMarkdownMemoryStore,
  createMemoryInductionPromptStore,
  createPromptProfileStore,
  promptStoragePath,
  runMemoryInductionForMessages
};
export type { LLMChatInput, LLMClient, StoredConversationMessage };

export function createAdminHandler(context: any) {
  return createApiRequestHandler({ services: createAdminRouteServices(context) });
}

export async function assertPatchError(handler: ReturnType<typeof createAdminHandler>, url: string, body: Record<string, unknown>, error: string) {
  const response = createResponse();
  await handler(createRequest("PATCH", url, body), response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, error);
}

export function baseContext(root: string, memoryStore: ReturnType<typeof createMarkdownMemoryStore>, promptStore: ReturnType<typeof createMemoryInductionPromptStore>) {
  return {
    config: {
      project: { username: "user" },
      memoryFiles: { root },
      memorySummary: {
        enabled: true,
        manualRunRequiresSleeping: true,
        baseURL: "https://default.example.test/v1",
        apiKey: "default-key",
        model: "default-memory-model",
        temperature: 0.2,
        timeoutMs: 60_000,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      },
      llm: {
        provider: "stub",
        baseURL: "",
        apiKey: "",
        model: "core-model",
        temperature: 0.2,
        timeoutMs: 60_000,
        stream: false,
        extraParams: {},
        followupExtraParams: {}
      },
      plugins: { wechat: { enabled: false }, feishu: { enabled: false } },
      bashSandbox: {
        containerName: "alice-bash-sandbox",
        image: "cimg/python:3.13-browsers",
        defaultCwd: "/home/alice",
        hostWorkspaceDir: path.join(root, "sandbox", "alice"),
        workspaceDir: "/home/alice",
        hostCacheDir: path.join(root, "sandbox", "cache"),
        cacheDir: "/cache",
        tmpDir: "/tmp",
        skillsDir: "/home/alice/.agent/skills",
        notesDir: "/home/alice/.agent/notes",
        skillMounts: [],
        mounts: [],
        network: "none",
        timeoutMs: 60_000,
        outputLimitBytes: 128 * 1024,
        pidsLimit: 256,
      },
      core: { timezone: "Asia/Shanghai" }
    },
    logs: [],
    messageLogs: [],
    llmRequestLogs: [],
    llmResponseLogs: [],
    getCurrentLLMSession: () => undefined,
    getClearedLLMSessions: () => [],
    getMemoryLLMSessions: () => [],
    getLLMSession: () => undefined,
    store: undefined,
    getLLMRequestPreview: () => undefined,
    getLLMRequestProfilePreview: () => undefined,
    getPromptRenderer() {
      return createPromptContextRuntime({
        username: this.config.project.username,
        time: this.time,
        dailyShellStore: this.dailyShellStore,
        coreProfileStore: this.coreProfileStore,
        memoryStore: this.memoryStore,
        diaryStore: this.diaryStore,
        calendarStore: this.calendarStore,
        skillsDirPath: this.config.bashSandbox.skillsDir,
        skillsRegistry: { available: () => [] },
        worldWandererConfigPath: this.pluginConfigs?.worldWanderer?.configPath
      });
    },
    getPromptVariableTree() {
      return promptVariableTree(this.getPromptRenderer());
    },
    getTokenUsageReport: () => ({}),
    clearLLMChainCache() {},
    cancelActiveLLMRun: () => ({ ok: true, hadActiveRequest: false }),
    clearMemoryInductionSession() {},
    outputRouter: { listChannels: () => [] },
    feishuPairingStore: { list: () => [] },
    coreProfileStore: { get: () => ({ appearanceDescription: "", librarySetting: "" }) },
    promptProfileStore: { get: () => ({ layers: [], visibleTools: {} }), save: (profile: unknown) => profile },
    talkPromptProfileStore: { get: () => ({ layers: [], visibleTools: {} }), save: (profile: unknown) => profile },
    memoryStore,
    diaryStore: {
      listSleepBoundaries: () => [
        { occurredAt: "2026-05-23T22:00:00.000", source: "inferred_start" },
        { occurredAt: "2026-05-24T06:00:00.000", source: "sleep" }
      ],
      latestWakeBoundary: () => undefined,
      recordSleepBoundary() {}
    },
    calendarStore: {
      latestBirthday: () => undefined,
      listEntries: () => [],
      replaceBirthday() {
        throw new Error("calendar_store_unavailable");
      }
    },
    memoryInductionPromptStore: promptStore,
    runMemoryInductionForMessages: async () => ({ ok: false, startedAt: "", windowEndAt: "", messageCount: 0, results: [] }),
    getDailyShell: () => "",
    dailyShellStore: {
      get: () => ({
        date: "2026-05-24",
        createdAt: "2026-05-24T06:00:00.000Z",
        personality: { id: "default", name: "Default", content: "" },
        relationship: { id: "default", name: "Default", content: "" },
        outfit: { id: "default", name: "Default", content: "" }
      }),
      getConfig: () => ({}),
      render: () => "",
      reroll() {},
      listSwitchLogs: () => []
    },
    agentState: { getSnapshot: () => ({ state: "sleeping" }), setState() {} },
    messagingTools: emptyPlugin("messaging"),
    photoTools: emptyPlugin("photo"),
    wardrobeTools: emptyPlugin("wardrobe"),
    bookcaseTools: emptyPlugin("bookcase"),
    sleepCocoonTools: emptyPlugin("sleep-cocoon"),
    calendarTools: emptyPlugin("calendar"),
    feishu: { async start() {}, async stop() {}, async send() {} },
    wechat: { async start() {}, async stop() {}, async send() {} },
    wechatStateStore: {
      listContacts: () => [],
      getCredentials: () => undefined,
      saveCredentials() {},
      clearCredentials() {}
    },
    runtime: { feishuStarted: false, wechatStarted: false },
    messageRuntime: { pauseHeartbeat() {}, resumeHeartbeat() {}, async processNow() {}, getStatus: () => ({}) },
    getLLM: () => editToolClient([], []),
    reloadLLM() {},
    time: {
      timeZone: "Asia/Shanghai",
      now: () => ({ iso: "2026-05-24T06:00:00.000Z", date: new Date("2026-05-24T06:00:00.000Z") })
    },
    setTimeZone() {},
    appendLog() {},
    appendMessageLog: () => ({})
  } as any;
}

export function emptyPlugin(id: string) {
  return {
    id,
    listTools: () => [],
    async execute() {
      return { ok: false, error: "not implemented" };
    }
  };
}

export function photoDefaults() {
  return {
    selfieReferenceDir: "assets/selfie/references",
    selfieOutputDir: "assets/generated/selfies",
    selfieCodexCommand: "codex",
    selfieCodexExtraPrompt: "",
    selfieCodexTimeoutMs: 180_000,
    selfieImageApiBaseURL: "https://api.openai.com/v1",
    selfieImageApiRelayBaseURL: "https://api.openai.com/v1",
    selfieImageApiModel: "gpt-image-2",
    selfieImageApiSize: "768x1024",
    selfieImageApiQuality: "low",
    selfieImageApiModeration: "low",
    selfieImageApiOutputFormat: "jpeg",
    selfieImageApiOutputCompression: 45,
    selfieImageApiTimeoutMs: 120_000,
    selfieImageApiRelayModel: "gpt-image-2",
    selfieImageApiRelaySize: "768x1024",
    selfieImageApiRelayQuality: "low",
    selfieImageApiRelayModeration: "low",
    selfieImageApiRelayOutputFormat: "jpeg",
    selfieImageApiRelayOutputCompression: 45,
    selfieImageApiRelayTimeoutMs: 120_000,
    selfieMaxBytes: 10 * 1024 * 1024,
    autoGenerateOutfitOnBody: false,
    selfie2DinRealEnabled: false,
    selfie2DinRealReferenceImage: "assets/selfie/references/2dinreal-reference.jpg",
    selfie2DinRealPrompt: ""
  };
}

export function createRequest(method: string, url: string, body: Record<string, unknown>) {
  const request = Readable.from([JSON.stringify(body)]) as any;
  request.method = method;
  request.url = url;
  request.socket = { remoteAddress: "127.0.0.1" };
  request.headers = {};
  return request;
}

export function createRawRequest(method: string, url: string, body: Buffer, headers: Record<string, string> = {}) {
  const request = Readable.from([body]) as any;
  request.method = method;
  request.url = url;
  request.socket = { remoteAddress: "127.0.0.1" };
  request.headers = headers;
  return request;
}

export function makeTinyWavBuffer(): Buffer {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 16;
  const samples = 400;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((i / sampleRate) * Math.PI * 2 * 440) * 1_000);
    buffer.writeInt16LE(value, 44 + (i * bytesPerSample));
  }
  return buffer;
}

export function writePreset(root: string, name: string) {
  const filePath = path.join(root, "config", "llm-api-presets.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : { presets: [] };
  const presets = Array.isArray(current.presets) ? current.presets.filter((entry: { name?: string }) => entry.name !== name) : [];
  presets.push({
    name,
    baseURL: "https://llm.example.test/v1",
    apiKey: "secret",
    model: "flash",
    temperature: 0.2,
    timeoutMs: 60_000,
    stream: false,
    extraParams: {},
    followupExtraParams: {}
  });
  fs.writeFileSync(filePath, `${JSON.stringify({ presets })}\n`);
}

export function writeTtsPluginConfig(root: string, input: {
  configPath: string;
  enabled?: boolean;
  activePresetName?: string;
  preset?: Record<string, unknown>;
  translation?: Record<string, unknown>;
}) {
  const activePresetName = input.activePresetName ?? "genie-jp";
  const translationInput = input.translation ?? {};
  const { translationPresetName = "default", translationPresets, ...translationPreset } = translationInput;
  fs.mkdirSync(path.dirname(input.configPath), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(input.configPath), "presets"), { recursive: true });
  fs.writeFileSync(input.configPath, `${JSON.stringify({
    enabled: input.enabled ?? false,
    activePresetName,
    translationPresetName,
    translationPresets: translationPresets ?? {
      [String(translationPresetName)]: {
        translationEnabled: false,
        ...translationPreset
      }
    }
  })}\n`);
  fs.writeFileSync(path.join(path.dirname(input.configPath), "presets", `${activePresetName}.json`), `${JSON.stringify(input.preset ?? {
    provider: "genie",
    genie: {
      enabled: true,
      baseURL: "http://127.0.0.1:8767",
      localFallbackEnabled: true,
      language: "jp",
      modelDir: `assets/tts/preset/${activePresetName}/model`,
      splitText: false
    }
  }, null, 2)}\n`);
}

export function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk: string) {
      this.body = chunk;
    }
  };
}

export function editToolClient(seen: LLMChatInput[], patches: string[]): LLMClient {
  let index = 0;
  let finishNext = false;
  return {
    async chat(input) {
      seen.push(input);
      if (finishNext) {
        finishNext = false;
        return { message: { role: "assistant", content: "done" } };
      }
      const patch = patches[index++] ?? addPatch("fallback\n");
      finishNext = true;
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `edit_${index}`,
            type: "function",
            function: {
              name: "apply_patch",
              arguments: JSON.stringify({ patch })
            }
          }]
        }
      };
    }
  };
}

export function addPatch(content: string): string {
  const lines = content.trimEnd().split("\n");
  return [
    "--- a/memory.md",
    "+++ b/memory.md",
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n");
}

export function message(createdAt: string, contentText: string): StoredConversationMessage {
  return {
    id: 1,
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
