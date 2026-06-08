import type { AgentEvent } from "../../../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type WeChatContact = {
  userId: string;
  sessionId: string;
  contextToken: string;
  lastMessageId?: string;
  lastSeenAt: string;
};

export type WeChatState = {
  getUpdatesBuf: string;
  credentials?: {
    botToken: string;
    baseURL: string;
    loggedInAt: string;
  };
  contacts: Record<string, WeChatContact>;
};

export type WeChatStateStore = {
  load(): WeChatState;
  save(state: WeChatState): void;
  getCredentials(): WeChatState["credentials"];
  saveCredentials(credentials: NonNullable<WeChatState["credentials"]>): void;
  clearCredentials(): void;
  noteInbound(event: AgentEvent, contextToken: string): WeChatContact | undefined;
  getContact(userId: string): WeChatContact | undefined;
  listContacts(): WeChatContact[];
  getDefaultTarget(): { plugin: "wechat"; accountId: string; userId: string; channelId: string; sessionId: string } | undefined;
};

const emptyState = (): WeChatState => ({ getUpdatesBuf: "", contacts: {} });

export function createWeChatStateStore(filePath: string): WeChatStateStore {
  let state = readState(filePath);

  function persist(): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  return {
    load() {
      state = readState(filePath);
      return cloneState(state);
    },
    save(next) {
      state = cloneState(next);
      persist();
    },
    getCredentials() {
      return state.credentials ? { ...state.credentials } : undefined;
    },
    saveCredentials(credentials) {
      state.credentials = { ...credentials };
      state.getUpdatesBuf = "";
      persist();
    },
    clearCredentials() {
      state.credentials = undefined;
      state.getUpdatesBuf = "";
      persist();
    },
    noteInbound(event, contextToken) {
      const userId = event.source.userId;
      if (!userId) return undefined;
      const contact = {
        userId,
        sessionId: event.session.sessionId,
        contextToken,
        lastMessageId: event.source.rawMessageId,
        lastSeenAt: event.meta.receivedAt
      };
      state.contacts[userId] = contact;
      persist();
      return contact;
    },
    getContact(userId) {
      return state.contacts[userId];
    },
    listContacts() {
      return Object.values(state.contacts).sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    },
    getDefaultTarget() {
      const contact = this.listContacts()[0];
      if (!contact) return undefined;
      return {
        plugin: "wechat",
        accountId: "main",
        userId: contact.userId,
        channelId: contact.userId,
        sessionId: contact.sessionId
      };
    }
  };
}

function readState(filePath: string): WeChatState {
  if (!fs.existsSync(filePath)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WeChatState>;
    return {
      getUpdatesBuf: typeof parsed.getUpdatesBuf === "string" ? parsed.getUpdatesBuf : "",
      credentials: normalizeCredentials(parsed.credentials),
      contacts: isRecord(parsed.contacts) ? normalizeContacts(parsed.contacts) : {}
    };
  } catch {
    return emptyState();
  }
}

function normalizeContacts(value: Record<string, unknown>): Record<string, WeChatContact> {
  const contacts: Record<string, WeChatContact> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    const userId = typeof item.userId === "string" ? item.userId : key;
    const sessionId = typeof item.sessionId === "string" ? item.sessionId : `wechat:dm:${userId}`;
    const contextToken = typeof item.contextToken === "string" ? item.contextToken : "";
    if (!contextToken) continue;
    contacts[userId] = {
      userId,
      sessionId,
      contextToken,
      lastMessageId: typeof item.lastMessageId === "string" ? item.lastMessageId : undefined,
      lastSeenAt: typeof item.lastSeenAt === "string" ? item.lastSeenAt : new Date(0).toISOString()
    };
  }
  return contacts;
}

function cloneState(state: WeChatState): WeChatState {
  return {
    getUpdatesBuf: state.getUpdatesBuf,
    credentials: state.credentials ? { ...state.credentials } : undefined,
    contacts: Object.fromEntries(Object.entries(state.contacts).map(([key, value]) => [key, { ...value }]))
  };
}

function normalizeCredentials(value: unknown): WeChatState["credentials"] {
  if (!isRecord(value)) return undefined;
  const botToken = typeof value.botToken === "string" ? value.botToken : "";
  const baseURL = typeof value.baseURL === "string" ? value.baseURL : "";
  if (!botToken || !baseURL) return undefined;
  return {
    botToken,
    baseURL,
    loggedInAt: typeof value.loggedInAt === "string" ? value.loggedInAt : new Date(0).toISOString()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
