import type { AgentEvent } from "../../../packages/types/src/index.js";
import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import type { WeChatStateStore } from "./state.js";

export type WeChatConfig = {
  enabled: boolean;
  botToken?: string;
  baseURL: string;
  pollTimeoutMs: number;
};

export type WeChatPluginDeps = {
  onEvent(event: AgentEvent): Promise<void>;
  log?(level: "info" | "warn" | "error", message: string): void;
  time?: CurrentTimeProvider;
  stateStore: WeChatStateStore;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type WeChatTextMessage = {
  id: string;
  fromUserId: string;
  text: string;
  contextToken: string;
  createdAt?: string;
  raw: unknown;
};

export type WeChatLoginQRCode = {
  qrcode: string;
  qrcodeUrl?: string;
  qrcodeContent?: string;
  qrcodeBase64?: string;
  status?: string;
  raw: unknown;
};

export type WeChatQRCodeStatus = {
  status: "wait" | "scaned" | "confirmed" | "expired" | string;
  botToken?: string;
  baseURL?: string;
  raw: unknown;
};

export type WeChatUpdates = {
  nextCursor?: string;
  messages: WeChatTextMessage[];
};
