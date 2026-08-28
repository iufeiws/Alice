import type { VoiceSynthesizer } from "../../../../channels/tts/src/index.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import type { BashSandboxConfig } from "../../../../contexts/bash-sandbox/src/index.js";
import type { ToolPlugin } from "../../../../contexts/tool-execution/src/index.js";
import type {
  AliceStore
} from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";

export type MessagingToolTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type MessagingToolsDeps = {
  store: Pick<
    AliceStore,
    | "listMessagesForConversation"
    | "listMessages"
    | "listMessagesByCreatedAtRange"
    | "markMessagesReadAndCoreProcessed"
    | "insertOutboundMessage"
    | "markOutboundMessageSent"
    | "markOutboundMessageFailed"
  >;
  outputRouter: Pick<OutputRouter, "send">;
  time?: CurrentTimeProvider;
  sleep?: (ms: number) => Promise<void>;
  voiceSynthesizer?: VoiceSynthesizer;
  voiceMessageTtsTrainingOutputDir?: string;
  wechatVoiceFallbackToText?: boolean;
  config?: MessagingPluginConfig | (() => MessagingPluginConfig);
  bashSandbox?: BashSandboxConfig;
  sandboxSendOutputDir?: string;
  sandboxSendAssetRoot?: string;
  getUserName?: () => string;
  getDefaultTarget?(): MessagingToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
  getShellSwitchLogs?(): Array<{
    time: string;
    personalityName: string;
    relationshipName: string;
  }>;
  getSleepCocoonEnteredAt?(): string | undefined;
  getLatestShortMemoryCreatedAtUtc?(): string | undefined;
  appendMessageLog?(input: {
    direction: "inbound" | "outbound";
    plugin: string;
    kind: string;
    target?: string;
    sessionId?: string;
    status?: string;
    summary: string;
    error?: string;
  }): unknown;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export type MessagingPluginConfig = {
  splitMultilineSendChat: boolean;
  limitConsecutiveSends: boolean;
  feishuTypingEmojiEnabled: boolean;
  mapMarkdownLikeToMarkdown: boolean;
};

export type MessagingToolPlugin = ToolPlugin & {
  noteLLMRequestStarted(): void;
  noteLLMSessionCompleted(): void;
};

export type SendType = "message" | "markdown" | "image" | "voice" | "file";

export type SendPartResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
  content: string;
  storedId?: number;
};

export type ShellSwitchContextEntry = {
  kind: "shell";
  time: Date;
  personalityName: string;
  relationshipName: string;
};

export type VoiceCallTranscriptRow = {
  sessionId: string;
  entryId?: string;
  role: "system" | "assistant" | "user";
  contentText: string;
  durationMs?: number;
};
